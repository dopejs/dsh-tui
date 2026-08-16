import { describe, expect, it, vi } from 'vitest'

import {
  SessionAttachmentCoordinator,
  type SessionBindingFactory,
  type SwitchableSessionBinding,
} from './session-attachment-coordinator'

interface FixtureBinding extends SwitchableSessionBinding {
  readonly label: string
}

function harness() {
  let active = 0
  const accepting = new Map<string, boolean>()
  const order: string[] = []
  const binding = (sessionId: string): FixtureBinding => {
    active += 1
    accepting.set(sessionId, true)
    let disposed = false
    return {
      label: sessionId,
      sessionId,
      async dispose() {
        if (disposed) return
        disposed = true
        order.push(`dispose:${sessionId}`)
        active -= 1
      },
      setAcceptingInput(value) {
        accepting.set(sessionId, value)
      },
    }
  }
  const preflight = vi.fn(async (sessionId: string) => {
    order.push(`preflight:${sessionId}`)
  })
  const resume = vi.fn(async (sessionId: string, signal: AbortSignal) => {
    void signal
    order.push(`resume:${sessionId}`)
    if (active !== 0) throw new Error('overlapping live binding')
    return binding(sessionId)
  })
  const factory: SessionBindingFactory<FixtureBinding> = { preflight, resume }
  return {
    accepting: (sessionId: string) => accepting.get(sessionId),
    active: () => active,
    binding,
    factory,
    order,
    preflight,
    resume,
  }
}

describe('SessionAttachmentCoordinator (M1.4)', () => {
  it('preflights, fully disposes the old binding, then publishes the new binding', async () => {
    const fixture = harness()
    const lifecycle = new AbortController()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: vi.fn(),
      signal: lifecycle.signal,
    })

    await coordinator.switchSession('b', new AbortController().signal)
    expect(fixture.order).toEqual(['preflight:b', 'dispose:a', 'resume:b'])
    expect(fixture.active()).toBe(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      binding: { sessionId: 'b' },
      status: 'attached',
    })

    await coordinator.dispose()
    expect(fixture.active()).toBe(0)
  })

  it('disables the attached application during preflight and restores it on failure', async () => {
    const fixture = harness()
    let rejectPreflight!: (error: unknown) => void
    fixture.preflight.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectPreflight = reject
    }))
    const fatal = vi.fn()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: fatal,
      signal: new AbortController().signal,
    })

    const switching = coordinator.switchSession('bad', new AbortController().signal)
    await vi.waitFor(() => expect(coordinator.getSnapshot()).toMatchObject({
      binding: { sessionId: 'a' },
      status: 'switching',
      targetSessionId: 'bad',
    }))
    expect(fixture.accepting('a')).toBe(false)
    rejectPreflight(new Error('corrupt target'))
    await expect(switching).rejects.toThrow('corrupt target')
    expect(fixture.order).toEqual([])
    expect(coordinator.getSnapshot()).toMatchObject({
      binding: { sessionId: 'a' },
      error: 'corrupt target',
      status: 'attached',
    })
    expect(fixture.accepting('a')).toBe(true)
    expect(fatal).not.toHaveBeenCalled()

    await coordinator.dispose()
  })

  it('restores the previous session without overlap when target resume fails', async () => {
    const fixture = harness()
    fixture.resume.mockImplementationOnce(async (sessionId: string) => {
      fixture.order.push(`resume:${sessionId}`)
      throw new Error('target failed')
    })
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: vi.fn(),
      signal: new AbortController().signal,
    })

    await expect(coordinator.switchSession('b', new AbortController().signal))
      .rejects.toThrow('target failed')
    expect(fixture.order).toEqual(['preflight:b', 'dispose:a', 'resume:b', 'resume:a'])
    expect(fixture.active()).toBe(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      binding: { sessionId: 'a' },
      error: 'target failed',
      status: 'attached',
    })

    await coordinator.dispose()
  })

  it('reports a fatal failure when neither target nor previous session can attach', async () => {
    const fixture = harness()
    fixture.resume.mockRejectedValue(new Error('resume unavailable'))
    const fatal = vi.fn()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: fatal,
      signal: new AbortController().signal,
    })

    await expect(coordinator.switchSession('b', new AbortController().signal))
      .rejects.toThrow('could not be restored')
    expect(fatal).toHaveBeenCalledOnce()
    expect(fixture.active()).toBe(0)
    expect(coordinator.getSnapshot()).toMatchObject({ status: 'failed' })
    expect(coordinator.getSnapshot().binding).toBeUndefined()

    await coordinator.dispose()
  })

  it('rejects concurrent transitions and becomes quiescent on disposal', async () => {
    const fixture = harness()
    let settle!: () => void
    fixture.preflight.mockImplementationOnce(() => new Promise<void>((resolve) => {
      settle = resolve
    }))
    const lifecycle = new AbortController()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: vi.fn(),
      signal: lifecycle.signal,
    })
    const switching = coordinator.switchSession('b', new AbortController().signal)
    await vi.waitFor(() => expect(fixture.preflight).toHaveBeenCalledOnce())
    await expect(coordinator.switchSession('c', new AbortController().signal))
      .rejects.toThrow('already running')

    const disposal = coordinator.dispose()
    settle()
    await expect(switching).rejects.toThrow('disposed')
    await disposal
    expect(fixture.active()).toBe(0)
    expect(() => coordinator.switchSession('c', new AbortController().signal)).toThrow('disposed')
  })

  it('fails closed without resuming a second handle when old disposal fails', async () => {
    const fixture = harness()
    const initial: FixtureBinding = {
      label: 'a',
      sessionId: 'a',
      dispose: vi.fn(async () => { throw new Error('old handle stuck') }),
      setAcceptingInput: vi.fn(),
    }
    const fatal = vi.fn()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial,
      onFatal: fatal,
      signal: new AbortController().signal,
    })

    await expect(coordinator.switchSession('b', new AbortController().signal))
      .rejects.toThrow('old handle stuck')
    expect(fixture.resume).not.toHaveBeenCalled()
    expect(fatal).toHaveBeenCalledOnce()
    await expect(coordinator.dispose()).rejects.toThrow('old handle stuck')
  })

  it('does not restore over a target handle that failed disposal after cancellation', async () => {
    const fixture = harness()
    const caller = new AbortController()
    fixture.resume.mockImplementationOnce(async () => {
      caller.abort(new Error('caller cancelled'))
      return {
        label: 'b',
        sessionId: 'b',
        dispose: async () => { throw new Error('target handle stuck') },
        setAcceptingInput: vi.fn(),
      }
    })
    const fatal = vi.fn()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: fatal,
      signal: new AbortController().signal,
    })

    await expect(coordinator.switchSession('b', caller.signal))
      .rejects.toThrow('could not be disposed safely')
    expect(fixture.resume).toHaveBeenCalledTimes(1)
    expect(fatal).toHaveBeenCalledOnce()
    expect(coordinator.getSnapshot()).toMatchObject({ status: 'failed' })
    await coordinator.dispose()
  })

  it('surfaces target cleanup failure when disposal cancels an in-flight transition', async () => {
    const fixture = harness()
    const lifecycle = new AbortController()
    fixture.resume.mockImplementationOnce(async (_sessionId: string, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {
        once: true,
      }))
      return {
        label: 'b',
        sessionId: 'b',
        dispose: async () => { throw new Error('target cleanup failed') },
        setAcceptingInput: vi.fn(),
      }
    })
    const fatal = vi.fn()
    const coordinator = new SessionAttachmentCoordinator({
      factory: fixture.factory,
      initial: fixture.binding('a'),
      onFatal: fatal,
      signal: lifecycle.signal,
    })
    const switching = coordinator.switchSession('b', new AbortController().signal)
    await vi.waitFor(() => expect(fixture.resume).toHaveBeenCalledOnce())

    const disposal = coordinator.dispose()
    await expect(switching).rejects.toThrow('could not be disposed safely')
    await expect(disposal).rejects.toThrow('could not be disposed safely')
    expect(fatal).toHaveBeenCalledOnce()
  })
})
