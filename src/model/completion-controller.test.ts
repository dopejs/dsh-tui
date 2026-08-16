import { describe, expect, it, vi } from 'vitest'

import {
  CompletionController,
  extractCompletionContext,
  type CompletionOption,
  type CompletionProvider,
  type CompletionRequest,
} from './completion-controller'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const option = (id: string, replacement = id): CompletionOption => ({
  id,
  label: id,
  replacement,
})

describe('extractCompletionContext (M1.3)', () => {
  it('extracts command and explicit workspace-path replacement ranges', () => {
    expect(extractCompletionContext('/rev tail', 4)).toEqual({
      end: 4,
      kind: 'command',
      query: 'rev',
      start: 0,
    })
    expect(extractCompletionContext('read @src/old.ts now', 10)).toEqual({
      end: 16,
      kind: 'path',
      query: 'src/',
      start: 6,
    })
    expect(extractCompletionContext('/review src/old.ts', 12)).toEqual({
      end: 18,
      kind: 'path',
      query: 'src/',
      start: 8,
    })
    expect(extractCompletionContext('ordinary text', 8)).toBeUndefined()
    expect(() => extractCompletionContext('x', 2)).toThrow('cursor')
  })
})

describe('CompletionController (M1.3)', () => {
  it('publishes a bounded ready result and wrapped selection', async () => {
    const complete = vi.fn(async (request: CompletionRequest) => [
      option(`${request.kind}:one`, '/one'),
      option(`${request.kind}:two`, '/two'),
      option(`${request.kind}:three`, '/three'),
    ])
    const controller = new CompletionController({ complete }, { maxResults: 2 })

    expect(controller.request('/o', 2)).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      kind: 'command',
      query: 'o',
      status: 'loading',
    })
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      truncated: true,
    }))
    expect(controller.getSnapshot().items).toHaveLength(2)
    expect(controller.move('up')).toBe(true)
    expect(controller.selected()).toMatchObject({ end: 2, replacement: '/two', start: 0 })
    expect(controller.move('down')).toBe(true)

    await controller.dispose()
  })

  it('aborts and ignores stale generations even when a provider settles late', async () => {
    const first = deferred<readonly CompletionOption[]>()
    const second = deferred<readonly CompletionOption[]>()
    const requests: CompletionRequest[] = []
    const provider: CompletionProvider = {
      complete(request) {
        requests.push(request)
        return requests.length === 1 ? first.promise : second.promise
      },
    }
    const controller = new CompletionController(provider)

    controller.request('/a', 2)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    controller.request('/b', 2)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]?.signal.aborted).toBe(true)
    second.resolve([option('new', '/beta')])
    await vi.waitFor(() => expect(controller.selected()?.id).toBe('new'))
    first.resolve([option('old', '/alpha')])
    await first.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(controller.selected()?.id).toBe('new')

    await controller.dispose()
  })

  it('contains provider failures and clears unsupported requests', async () => {
    const provider: CompletionProvider = {
      complete: async () => { throw new Error('completion unavailable') },
    }
    const controller = new CompletionController(provider)

    controller.request('@src', 4)
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      error: 'completion unavailable',
      status: 'error',
    }))
    expect(controller.request('plain', 5)).toBe(false)
    expect(controller.getSnapshot().status).toBe('idle')

    await controller.dispose()
  })

  it('waits for owned work during disposal and publishes no late result', async () => {
    const pending = deferred<readonly CompletionOption[]>()
    const provider: CompletionProvider = { complete: () => pending.promise }
    const controller = new CompletionController(provider)
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.request('/x', 2)
    await new Promise<void>(resolve => setImmediate(resolve))

    let disposed = false
    const disposal = controller.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    pending.resolve([option('late')])
    await disposal
    expect(listener).toHaveBeenCalledOnce()
    expect(() => controller.request('/x', 2)).toThrow('disposed')
  })

  it('validates request limits', () => {
    const provider: CompletionProvider = { complete: async () => [] }
    expect(() => new CompletionController(provider, { maxPendingRequests: 0 })).toThrow('maxPendingRequests')
    expect(() => new CompletionController(provider, { maxResults: 0 })).toThrow('maxResults')
  })
})
