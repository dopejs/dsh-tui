import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  TranscriptController,
  type RepaintScheduler,
} from './transcript-controller'

type MessageId = SessionEvent<'user/message'>['data']['id']

class ManualScheduler implements RepaintScheduler {
  readonly tasks: Array<() => void> = []

  schedule(task: () => void): () => void {
    this.tasks.push(task)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.tasks.indexOf(task)
      if (index >= 0) this.tasks.splice(index, 1)
    }
  }

  flush(): void {
    const tasks = this.tasks.splice(0)
    for (const task of tasks) task()
  }
}

function message(seq: number, text: string): SessionEvent<'user/message'> {
  return {
    data: {
      content: [{ text, type: 'text' }],
      id: `message-${String(seq)}` as MessageId,
      role: 'user',
      source: { kind: 'user' },
    },
    seq,
    time: seq,
    type: 'user/message',
  }
}

describe('TranscriptController', () => {
  it('updates synchronously while coalescing repaint notifications', async () => {
    const scheduler = new ManualScheduler()
    const controller = new TranscriptController({ scheduler })
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.accept([message(0, 'first')])
    controller.accept([message(1, 'second')])

    expect(controller.getSnapshot().rows.map(row => row.content))
      .toEqual(['first', 'second'])
    expect(listener).not.toHaveBeenCalled()
    expect(scheduler.tasks).toHaveLength(1)

    scheduler.flush()
    expect(listener).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('enforces default row and content budgets during a cold replay burst', async () => {
    const scheduler = new ManualScheduler()
    const controller = new TranscriptController({ scheduler })
    const events = Array.from({ length: 2_500 }, (_, seq) => message(seq, `row ${String(seq)}`))
    events.push(message(2_500, 'x'.repeat(20_001)))

    controller.accept(events)

    const snapshot = controller.getSnapshot()
    expect(snapshot.rows).toHaveLength(2_000)
    expect(snapshot.droppedRows).toBe(501)
    expect(snapshot.rows.at(-1)).toMatchObject({ truncated: true })
    expect(snapshot.rows.at(-1)?.content).toHaveLength(20_000)
    expect(scheduler.tasks).toHaveLength(1)
    await controller.dispose()
  })

  it('does not repaint for replay overlap and supports idempotent unsubscribe', async () => {
    const scheduler = new ManualScheduler()
    const controller = new TranscriptController({ scheduler })
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    const first = message(0, 'first')
    controller.accept([first])
    scheduler.flush()
    controller.accept([first])
    unsubscribe()
    unsubscribe()
    scheduler.flush()

    expect(listener).toHaveBeenCalledOnce()
    expect(scheduler.tasks).toHaveLength(0)
    await controller.dispose()
  })

  it('contains sync and async listener failures and continues notifying peers', async () => {
    const scheduler = new ManualScheduler()
    const failures: unknown[] = []
    const controller = new TranscriptController({
      reportError: error => {
        failures.push(error)
      },
      scheduler,
    })
    const peer = vi.fn()
    controller.subscribe(() => {
      throw new Error('sync listener failed')
    })
    controller.subscribe(async () => {
      throw new Error('async listener failed')
    })
    controller.subscribe(peer)

    controller.accept([message(0, 'first')])
    scheduler.flush()
    await controller.dispose()

    expect(peer).toHaveBeenCalledOnce()
    expect(failures).toHaveLength(2)
    expect(failures.map(error => (error as Error).message).sort()).toEqual([
      'async listener failed',
      'sync listener failed',
    ])
  })

  it('cancels a scheduled repaint and rejects work after disposal', async () => {
    const scheduler = new ManualScheduler()
    const controller = new TranscriptController({ scheduler })
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.accept([message(0, 'first')])

    const firstDispose = controller.dispose()
    expect(controller.dispose()).toBe(firstDispose)
    await firstDispose
    scheduler.flush()

    expect(listener).not.toHaveBeenCalled()
    expect(scheduler.tasks).toHaveLength(0)
    expect(() => controller.accept([])).toThrow('Transcript controller is disposed')
    expect(() => controller.subscribe(() => undefined))
      .toThrow('Transcript controller is disposed')
  })

  it('honors an aborted consumer without changing state', async () => {
    const controller = new TranscriptController()
    const abort = new AbortController()
    abort.abort(new Error('stop'))

    expect(() => controller.accept([message(0, 'never')], abort.signal))
      .toThrow('Transcript event consumption was aborted')
    expect(controller.getSnapshot().nextSeq).toBe(0)
    await controller.dispose()
  })

  it('commits a batch atomically when a later event is malformed', async () => {
    const controller = new TranscriptController()

    expect(() => controller.accept([message(0, 'valid'), message(2, 'gap')]))
      .toThrow('Session event sequence gap: expected 1, got 2')
    expect(controller.getSnapshot().nextSeq).toBe(0)
    expect(controller.getSnapshot().rows).toEqual([])
    await controller.dispose()
  })

  it('awaits asynchronous listener error reporting during disposal', async () => {
    const scheduler = new ManualScheduler()
    let finishReport: (() => void) | undefined
    const report = new Promise<void>((resolve) => {
      finishReport = resolve
    })
    const controller = new TranscriptController({
      reportError: () => report,
      scheduler,
    })
    controller.subscribe(() => {
      throw new Error('listener failed')
    })
    controller.accept([message(0, 'first')])
    scheduler.flush()

    let disposed = false
    const disposing = controller.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finishReport?.()
    await disposing
    expect(disposed).toBe(true)
  })

  it('surfaces error-reporter failure during quiescent disposal', async () => {
    const scheduler = new ManualScheduler()
    const controller = new TranscriptController({
      reportError: async () => {
        throw new Error('report failed')
      },
      scheduler,
    })
    controller.subscribe(() => {
      throw new Error('listener failed')
    })
    controller.accept([message(0, 'first')])
    scheduler.flush()

    await expect(controller.dispose()).rejects.toThrow(
      'Transcript controller did not dispose cleanly',
    )
  })
})
