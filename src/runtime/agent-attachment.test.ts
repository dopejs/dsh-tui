import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { attachAgent, type SessionEventBatch } from './agent-attachment'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
}

interface AgentFixture {
  readonly agent: Agent
  readonly agentCtx: Context
  readonly disposeHandle: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly handle: AgentHandle
  readonly session: FixtureSession
}

class FixtureSession {
  readonly #ctx: Context
  readonly #events: SessionEvent[]

  constructor(ctx: Context, events: readonly SessionEvent[] = []) {
    this.#ctx = ctx
    this.#events = [...events]
  }

  get events(): readonly SessionEvent[] {
    return Object.freeze([...this.#events])
  }

  get seq(): number {
    return this.#events.length
  }

  append(event: SessionEvent): void {
    this.#events.push(event)
    this.#ctx.emit(
      'session/event',
      this as unknown as Session,
      event,
    )
  }

  emitDuplicate(event: SessionEvent): void {
    this.#ctx.emit(
      'session/event',
      this as unknown as Session,
      event,
    )
  }
}

function deferred<T>(): Deferred<T> {
  let reject!: Deferred<T>['reject']
  let resolvePromise!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolve, rejectPromise) => {
    resolvePromise = resolve
    reject = rejectPromise
  })
  return { promise, reject, resolve: resolvePromise }
}

function event(seq: number): SessionEvent {
  return Object.freeze({
    data: { turn: seq + 1 },
    seq,
    time: seq,
    type: 'turn/start',
  }) as SessionEvent
}

function createAgentFixture(
  events: readonly SessionEvent[] = [],
  beforeDispose?: () => Promise<void> | void,
): AgentFixture {
  const agentCtx = new Context()
  const session = new FixtureSession(agentCtx, events)
  const agent = {
    ctx: agentCtx,
    id: 'fixture-session',
    options: {},
    session,
    status: 'idle',
  } as unknown as Agent
  const disposeHandle = vi.fn(async () => {
    await beforeDispose?.()
    await agentCtx.fiber.dispose()
  })
  return {
    agent,
    agentCtx,
    disposeHandle,
    handle: { agent, dispose: disposeHandle },
    session,
  }
}

function provideAgentServices(
  ctx: Context,
  fixture: AgentFixture,
  implementations: {
    readonly create?: (options: CreateAgentOptions) => Promise<AgentHandle>
    readonly resume?: (options: ResumeAgentOptions) => Promise<AgentHandle>
  } = {},
) {
  const create = vi.fn(implementations.create ?? (async (options: CreateAgentOptions) => {
    await options.setup?.(fixture.agentCtx)
    return fixture.handle
  }))
  const resume = vi.fn(implementations.resume ?? (async (options: ResumeAgentOptions) => {
    await options.setup?.(fixture.agentCtx)
    return fixture.handle
  }))
  ctx.provide('agents', { create, resume } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ model: 'fixture-model', provider: 'fixture-provider' }),
  } as never)
  return { create, resume }
}

function createOptions(
  signal: AbortSignal,
  onEvents: (batch: SessionEventBatch, signal: AbortSignal) => Promise<void> | void,
) {
  return {
    onEvents,
    request: {
      cwd: resolve('fixture-workspace'),
      kind: 'create' as const,
      sessionId: 'new-session',
    },
    signal,
  }
}

describe('attachAgent', () => {
  it('creates with the selected model, startup signal, cwd, and scoped setup', async () => {
    const ctx = new Context()
    const fixture = createAgentFixture([event(0)])
    const services = provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const batches: SessionEventBatch[] = []

    const attachment = await attachAgent(ctx, createOptions(abort.signal, (batch) => {
      batches.push(batch)
    }))

    expect(attachment.agent).toBe(fixture.agent)
    expect(services.create).toHaveBeenCalledOnce()
    expect(services.resume).not.toHaveBeenCalled()
    const options = services.create.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      agentOptions: { model: 'fixture-model', provider: 'fixture-provider' },
      meta: { cwd: resolve('fixture-workspace') },
      sessionId: 'new-session',
    })
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.setup).toBeTypeOf('function')
    expect(batches.map(batch => [batch.source, batch.events.map(item => item.seq)]))
      .toEqual([['replay', [0]]])

    await attachment.dispose()
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('resumes the requested persisted session through ctx.agents.resume', async () => {
    const ctx = new Context()
    const fixture = createAgentFixture()
    const services = provideAgentServices(ctx, fixture)
    const abort = new AbortController()

    const attachment = await attachAgent(ctx, {
      onEvents: () => undefined,
      request: { kind: 'resume', sessionId: 'persisted-session' },
      signal: abort.signal,
    })

    expect(services.create).not.toHaveBeenCalled()
    expect(services.resume).toHaveBeenCalledOnce()
    expect(services.resume.mock.calls[0]?.[0]).toMatchObject({
      agentOptions: { model: 'fixture-model', provider: 'fixture-provider' },
      resumeSessionId: 'persisted-session',
    })

    await attachment.dispose()
    await ctx.fiber.dispose()
  })

  it('performs listener-first replay/live handoff without duplicates or gaps', async () => {
    const ctx = new Context()
    const first = event(0)
    const second = event(1)
    const third = event(2)
    const fixture = createAgentFixture([first])
    provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const batches: SessionEventBatch[] = []

    const attachment = await attachAgent(ctx, createOptions(abort.signal, (batch) => {
      batches.push(batch)
      if (batch.source === 'replay') {
        fixture.session.emitDuplicate(first)
        fixture.session.append(second)
      }
    }))

    expect(batches.map(batch => [batch.source, batch.events.map(item => item.seq)]))
      .toEqual([
        ['replay', [0]],
        ['live', [1]],
      ])

    fixture.session.append(third)
    await vi.waitFor(() => {
      expect(batches.at(-1)?.events.map(item => item.seq)).toEqual([2])
    })

    await attachment.dispose()
    await ctx.fiber.dispose()
  })

  it('bounds replay batches', async () => {
    const ctx = new Context()
    const fixture = createAgentFixture([event(0), event(1), event(2), event(3), event(4)])
    provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const batchLengths: number[] = []

    const attachment = await attachAgent(ctx, {
      ...createOptions(abort.signal, (batch) => {
        batchLengths.push(batch.events.length)
      }),
      eventBatchSize: 2,
    })

    expect(batchLengths).toEqual([2, 2, 1])
    await attachment.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes a late handle when startup is aborted while create is pending', async () => {
    const ctx = new Context()
    const fixture = createAgentFixture()
    const pendingHandle = deferred<AgentHandle>()
    const services = provideAgentServices(ctx, fixture, {
      create: () => pendingHandle.promise,
    })
    const abort = new AbortController()
    const onEvents = vi.fn()
    const attaching = attachAgent(ctx, createOptions(abort.signal, onEvents))

    await vi.waitFor(() => {
      expect(services.create).toHaveBeenCalledOnce()
    })
    abort.abort()
    pendingHandle.resolve(fixture.handle)

    await expect(attaching).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    expect(onEvents).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rolls back the listener and exact handle when initial replay fails', async () => {
    const ctx = new Context()
    const late = event(1)
    const fixture = createAgentFixture([event(0)], () => {
      fixture.session.append(late)
    })
    provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const onEvents = vi.fn(() => {
      throw new Error('reducer failed')
    })

    await expect(attachAgent(ctx, createOptions(abort.signal, onEvents)))
      .rejects.toThrow('reducer failed')
    expect(onEvents).toHaveBeenCalledOnce()
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('preserves both startup and cleanup failures', async () => {
    const ctx = new Context()
    const cleanupFailure = new Error('handle cleanup failed')
    const fixture = createAgentFixture([event(0)], () => {
      throw cleanupFailure
    })
    provideAgentServices(ctx, fixture)
    const startupFailure = new Error('initial reducer failed')
    const abort = new AbortController()

    let caught: unknown
    try {
      await attachAgent(ctx, createOptions(abort.signal, () => {
        throw startupFailure
      }))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({
      errors: [startupFailure, expect.any(AggregateError)],
    })
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await fixture.agentCtx.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('awaits handle disposal exactly once and stops events before teardown', async () => {
    const ctx = new Context()
    const handleDisposed = deferred<undefined>()
    const fixture = createAgentFixture([], async () => {
      fixture.session.append(event(0))
      await handleDisposed.promise
    })
    provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const onEvents = vi.fn()
    const attachment = await attachAgent(ctx, createOptions(abort.signal, onEvents))

    const disposals = [attachment.dispose(), attachment.dispose()]
    await vi.waitFor(() => {
      expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    })
    expect(onEvents).not.toHaveBeenCalled()

    let settled = false
    void disposals[0]?.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    handleDisposed.resolve(undefined)
    await Promise.all(disposals)
    expect(settled).toBe(true)
    await ctx.fiber.dispose()
  })

  it('joins an in-flight live callback during disposal without reporting abort', async () => {
    const ctx = new Context()
    const fixture = createAgentFixture()
    provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const callbackStarted = deferred<undefined>()
    const releaseCallback = deferred<undefined>()
    const reportError = vi.fn()
    const onEvents = vi.fn(async () => {
      callbackStarted.resolve(undefined)
      await releaseCallback.promise
    })
    const attachment = await attachAgent(ctx, {
      ...createOptions(abort.signal, onEvents),
      onError: reportError,
    })

    fixture.session.append(event(0))
    await callbackStarted.promise
    const disposal = attachment.dispose()
    fixture.session.append(event(1))

    let settled = false
    void disposal.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseCallback.resolve(undefined)
    await disposal
    expect(onEvents).toHaveBeenCalledOnce()
    expect(reportError).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('still disposes the handle when listener removal fails', async () => {
    const ctx = new Context()
    const listenerFailure = new Error('listener removal failed')
    const disposeHandle = vi.fn(async () => undefined)
    const session = { events: Object.freeze([]), seq: 0 } as unknown as Session
    const agent = {
      ctx: {
        on: vi.fn(() => () => {
          throw listenerFailure
        }),
      },
      id: 'hostile-listener-agent',
      options: {},
      session,
      status: 'idle',
    } as unknown as Agent
    const create = vi.fn(async () => ({ agent, dispose: disposeHandle }))
    ctx.provide('agents', { create, resume: vi.fn() } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ model: 'fixture-model', provider: 'fixture-provider' }),
    } as never)
    const abort = new AbortController()
    const attachment = await attachAgent(ctx, createOptions(abort.signal, () => undefined))

    await expect(attachment.dispose()).rejects.toThrow(
      'One or more owned resources failed to dispose',
    )
    expect(disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('reports one live consumer failure and silences later callbacks', async () => {
    const ctx = new Context()
    const fixture = createAgentFixture()
    provideAgentServices(ctx, fixture)
    const abort = new AbortController()
    const failure = new Error('live reducer failed')
    const reportError = vi.fn()
    const onEvents = vi.fn(() => {
      throw failure
    })
    const attachment = await attachAgent(ctx, {
      ...createOptions(abort.signal, onEvents),
      onError: reportError,
    })

    fixture.session.append(event(0))
    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(failure)
    })
    fixture.session.append(event(1))
    await Promise.resolve()
    expect(onEvents).toHaveBeenCalledOnce()

    await attachment.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects malformed history, invalid bounds, and missing services', async () => {
    const malformedContext = new Context()
    const fixture = createAgentFixture([event(1)])
    provideAgentServices(malformedContext, fixture)
    const abort = new AbortController()

    await expect(attachAgent(
      malformedContext,
      createOptions(abort.signal, () => undefined),
    )).rejects.toThrow('expected 0, got 1')
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await malformedContext.fiber.dispose()

    const missingContext = new Context()
    await expect(attachAgent(
      missingContext,
      createOptions(abort.signal, () => undefined),
    )).rejects.toThrow('requires ctx.agents')
    await expect(attachAgent(missingContext, {
      ...createOptions(abort.signal, () => undefined),
      eventBatchSize: 0,
    })).rejects.toThrow('eventBatchSize')
    await missingContext.fiber.dispose()

    const missingModelContext = new Context()
    missingModelContext.provide('agents', {} as never)
    await expect(attachAgent(
      missingModelContext,
      createOptions(abort.signal, () => undefined),
    )).rejects.toThrow('requires ctx.agentDefaultModel')
    await missingModelContext.fiber.dispose()
  })
})
