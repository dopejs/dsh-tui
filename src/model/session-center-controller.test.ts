import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  SessionCenterController,
  type SessionPersistenceReader,
  type SessionSwitchTarget,
} from './session-center-controller'

function header(id: string, createdAt: number, cwd?: string): SessionHeader {
  return {
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    id: SessionId(id),
    version: 0,
  }
}

function event(seq: number, type: string): SessionEvent {
  return { data: {}, seq, time: seq, type } as SessionEvent
}

function fixture(
  headers: readonly SessionHeader[],
): {
  readonly persistence: SessionPersistenceReader
  readonly switchSession: ReturnType<typeof vi.fn>
  readonly target: SessionSwitchTarget
} {
  const persistence: SessionPersistenceReader = {
    inspect: vi.fn(async (id) => ({
      events: [event(0, 'session/start'), event(1, 'turn/end')],
      meta: headers.find(candidate => candidate.id === id) ?? header(String(id), 0),
    })),
    list: vi.fn(async () => [...headers]),
  }
  const switchSession = vi.fn(async () => undefined)
  return { persistence, switchSession, target: { switchSession } }
}

describe('SessionCenterController (M1.4)', () => {
  it('lists, sorts, filters, and bounds persisted session metadata', async () => {
    const source = fixture([
      header('old', 1, '/old'),
      header('current', 3, '/workspace'),
      header('other', 2, '/other'),
    ])
    const center = new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'current',
      maxResults: 2,
      maxSessions: 2,
    })

    center.refresh()
    await vi.waitFor(() => expect(center.getSnapshot().status).toBe('ready'))
    expect(center.getSnapshot()).toMatchObject({
      catalogTruncated: true,
      totalMatches: 2,
    })
    expect(center.getSnapshot().items.map(item => item.id)).toEqual(['current', 'other'])
    expect(center.getSnapshot().items[0]?.isCurrent).toBe(true)

    expect(center.insertQuery('OTHER')).toBe('applied')
    expect(center.getSnapshot().items.map(item => item.id)).toEqual(['other'])
    expect(center.backspaceQuery()).toBe(true)
    center.resetQuery()
    expect(center.getSnapshot().query).toBe('')

    await center.dispose()
  })

  it('previews the exact selected durable session without retaining its events', async () => {
    const source = fixture([header('one', 1), header('two', 2)])
    const center = new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'one',
    })
    center.refresh()
    await vi.waitFor(() => expect(center.getSnapshot().status).toBe('ready'))

    expect(center.inspectSelected()).toBe(true)
    await vi.waitFor(() => expect(center.getSnapshot()).toMatchObject({
      preview: { eventCount: 2, id: 'two', lastEventType: 'turn/end' },
      status: 'ready',
    }))
    expect(source.persistence.inspect).toHaveBeenCalledWith(
      SessionId('two'),
      expect.any(AbortSignal),
    )

    await center.dispose()
  })

  it('switches only to a non-current selected session and updates exact identity', async () => {
    const source = fixture([header('current', 2), header('target', 1)])
    const center = new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'current',
    })
    center.refresh()
    await vi.waitFor(() => expect(center.getSnapshot().status).toBe('ready'))

    expect(center.resumeSelected()).toBe(false)
    expect(center.move('down')).toBe(true)
    expect(center.resumeSelected()).toBe(true)
    expect(source.switchSession).toHaveBeenCalledWith('target', expect.any(AbortSignal))
    await vi.waitFor(() => expect(center.getSnapshot().status).toBe('ready'))
    expect(center.selected()?.isCurrent).toBe(true)
    expect(center.resumeSelected()).toBe(false)

    await center.dispose()
  })

  it('contains list/inspect/switch failures and can retry', async () => {
    let fail = true
    const persistence: SessionPersistenceReader = {
      inspect: vi.fn(async () => { throw new Error('corrupt session') }),
      list: vi.fn(async () => {
        if (fail) throw new Error('list unavailable')
        return [header('target', 1)]
      }),
    }
    const target: SessionSwitchTarget = {
      switchSession: vi.fn(async () => { throw new Error('resume failed') }),
    }
    const center = new SessionCenterController(persistence, target, {
      currentSessionId: 'current',
    })

    center.refresh()
    await vi.waitFor(() => expect(center.getSnapshot()).toMatchObject({
      error: 'list unavailable',
      status: 'error',
    }))
    fail = false
    center.refresh()
    await vi.waitFor(() => expect(center.getSnapshot().status).toBe('ready'))
    center.inspectSelected()
    await vi.waitFor(() => expect(center.getSnapshot()).toMatchObject({
      error: 'corrupt session',
      status: 'error',
    }))
    center.resumeSelected()
    await vi.waitFor(() => expect(center.getSnapshot()).toMatchObject({
      error: 'resume failed',
      status: 'error',
    }))

    await center.dispose()
  })

  it('aborts and awaits an owned operation during quiescent disposal', async () => {
    let observedSignal: AbortSignal | undefined
    let settle!: () => void
    const persistence: SessionPersistenceReader = {
      inspect: vi.fn(async () => ({ events: [], meta: header('one', 1) })),
      list: vi.fn(signal => new Promise<readonly SessionHeader[]>((resolve) => {
        observedSignal = signal
        settle = () => resolve([])
      })),
    }
    const center = new SessionCenterController(persistence, {
      switchSession: async () => undefined,
    }, { currentSessionId: 'current' })
    center.refresh()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    let disposed = false
    const disposal = center.dispose().then(() => { disposed = true })
    expect(observedSignal?.aborted).toBe(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    settle()
    await disposal
    expect(() => center.refresh()).toThrow('disposed')
  })

  it('validates all retention limits', () => {
    const source = fixture([])
    expect(() => new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'current',
      maxPendingOperations: 0,
    })).toThrow('maxPendingOperations')
    expect(() => new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'current',
      maxQueryCodeUnits: 0,
    })).toThrow('maxQueryCodeUnits')
    expect(() => new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'current',
      maxResults: 0,
    })).toThrow('maxResults')
    expect(() => new SessionCenterController(source.persistence, source.target, {
      currentSessionId: 'current',
      maxSessions: 0,
    })).toThrow('maxSessions')
  })
})
