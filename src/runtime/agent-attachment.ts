import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

import { ResourceOwner } from './resource-owner'

const DEFAULT_EVENT_BATCH_SIZE = 256
const ATTACHMENT_LOGGER_NAME = 'tui-runtime'

export type AgentAttachmentRequest =
  | {
      readonly cwd: string
      readonly kind: 'create'
      readonly modelSelection?: ModelSelection
      readonly sessionId: string
    }
  | {
      readonly kind: 'resume'
      readonly sessionId: string
    }
  | {
      readonly cwd: string
      readonly kind: 'fork'
      readonly modelSelection?: ModelSelection
      readonly parentSessionId: string
      readonly seed: readonly SessionEvent[]
      readonly sessionId: string
    }

export interface SessionEventBatch {
  readonly events: readonly SessionEvent[]
  readonly source: 'live' | 'replay'
}

export interface AgentAttachmentOptions {
  readonly eventBatchSize?: number
  readonly onAttached?: (agent: Agent) => void
  readonly onError?: (error: unknown) => Promise<void> | void
  readonly onEvents: (
    batch: SessionEventBatch,
    signal: AbortSignal,
  ) => Promise<void> | void
  readonly request: AgentAttachmentRequest
  readonly signal: AbortSignal
}

export interface AgentAttachment {
  readonly agent: Agent
  dispose(): Promise<void>
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('Agent attachment was aborted', { cause: reason })
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason)
}

function isExpectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && error.name === 'AbortError'
}

function validateBatchSize(value: number | undefined): number {
  const batchSize = value ?? DEFAULT_EVENT_BATCH_SIZE
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_024) {
    throw new RangeError('eventBatchSize must be a safe integer between 1 and 1024')
  }
  return batchSize
}

class SessionEventPump {
  readonly #agent: Agent
  readonly #batchSize: number
  readonly #ctx: Context
  readonly #onError: (error: unknown) => Promise<void> | void
  readonly #onEvents: AgentAttachmentOptions['onEvents']
  readonly #signal: AbortSignal
  readonly #initialSnapshot: readonly SessionEvent[]
  #dirty = false
  #disposed = false
  #disposing: Promise<void> | undefined
  #draining = false
  #drainTask: Promise<void> | undefined
  #failed = false
  #nextSeq = 0
  #phase: 'live' | 'replay' = 'replay'
  #scheduled = false
  #stopListening: (() => void) | undefined

  constructor(
    ctx: Context,
    agent: Agent,
    options: AgentAttachmentOptions,
    batchSize: number,
  ) {
    this.#agent = agent
    this.#batchSize = batchSize
    this.#ctx = ctx
    this.#onError = options.onError ?? ((error) => {
      ctx.logger(ATTACHMENT_LOGGER_NAME).error(error)
    })
    this.#onEvents = options.onEvents
    this.#signal = options.signal

    this.#stopListening = agent.ctx.on('session/event', (session) => {
      if (session !== agent.session || this.#disposed || this.#failed) return
      this.#dirty = true
      this.#scheduleDrain()
    })
    this.#initialSnapshot = agent.session.events
  }

  async replay(): Promise<void> {
    throwIfAborted(this.#signal)
    await this.#consume(this.#initialSnapshot, 'replay')
    this.#phase = 'live'
    this.#dirty ||= this.#agent.session.seq !== this.#nextSeq
    await this.#drainUntilCaughtUp()
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    const failures: unknown[] = []
    const stopError = this.#stop()
    if (stopError !== undefined) failures.push(stopError)
    try {
      await this.#drainTask
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Session event pump did not dispose cleanly')
    }
  }

  #stop(): unknown | undefined {
    const stopListening = this.#stopListening
    this.#stopListening = undefined
    try {
      stopListening?.()
    } catch (error) {
      return error
    }
  }

  #scheduleDrain(): void {
    if (
      this.#phase !== 'live'
      || this.#disposed
      || this.#failed
      || this.#draining
      || this.#scheduled
    ) {
      return
    }
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (this.#disposed || this.#failed) return

      this.#draining = true
      const task = this.#drainUntilCaughtUp()
        .catch(async (error: unknown) => {
          if (isExpectedAbort(error, this.#signal)) return
          this.#failed = true
          const stopError = this.#stop()
          await this.#reportError(
            stopError === undefined
              ? error
              : new AggregateError(
                  [error, stopError],
                  'Session event consumption failed while stopping its listener',
                ),
          )
        })
        .finally(() => {
          this.#draining = false
          if (this.#drainTask === task) this.#drainTask = undefined
          if (this.#dirty) this.#scheduleDrain()
        })
      this.#drainTask = task
    })
  }

  async #drainUntilCaughtUp(): Promise<void> {
    do {
      this.#dirty = false
      const snapshot = this.#agent.session.events
      await this.#consume(snapshot, 'live')
      this.#dirty ||= this.#agent.session.seq !== this.#nextSeq
    } while (this.#dirty && !this.#disposed)
  }

  async #consume(
    snapshot: readonly SessionEvent[],
    source: SessionEventBatch['source'],
  ): Promise<void> {
    if (snapshot.length < this.#nextSeq) {
      throw new Error(
        `Session event log shrank from ${String(this.#nextSeq)} to ${String(snapshot.length)}`,
      )
    }

    while (this.#nextSeq < snapshot.length) {
      throwIfAborted(this.#signal)
      const end = Math.min(snapshot.length, this.#nextSeq + this.#batchSize)
      const events = snapshot.slice(this.#nextSeq, end)
      for (const [offset, event] of events.entries()) {
        const expected = this.#nextSeq + offset
        if (event.seq !== expected) {
          throw new Error(
            `Session event sequence gap: expected ${String(expected)}, got ${String(event.seq)}`,
          )
        }
      }

      await this.#onEvents(
        { events: Object.freeze(events), source },
        this.#signal,
      )
      this.#nextSeq = end
      throwIfAborted(this.#signal)
    }
  }

  async #reportError(error: unknown): Promise<void> {
    try {
      await this.#onError(error)
    } catch (reportingError) {
      try {
        this.#ctx.logger(ATTACHMENT_LOGGER_NAME).error(
          new AggregateError(
            [error, reportingError],
            'Session event consumption and error reporting both failed',
          ),
        )
      } catch {
        // Error reporting must never create an unhandled owned task.
      }
    }
  }
}

function combineFailure(error: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [error, cleanupError],
    'Agent attachment failed and cleanup did not complete cleanly',
  )
}

export async function attachAgent(
  ctx: Context,
  options: AgentAttachmentOptions,
): Promise<AgentAttachment> {
  const batchSize = validateBatchSize(options.eventBatchSize)
  throwIfAborted(options.signal)

  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined) throw new Error('Agent attachment requires ctx.agents')
  if (defaultModel === undefined) {
    throw new Error('Agent attachment requires ctx.agentDefaultModel')
  }

  const lifecycleAbort = new AbortController()
  const forwardAbort = () => {
    lifecycleAbort.abort(options.signal.reason)
  }
  options.signal.addEventListener('abort', forwardAbort, { once: true })

  const owner = new ResourceOwner()
  try {
    const selection = options.request.kind !== 'resume'
      ? (options.request.modelSelection ?? defaultModel.currentSelection())
      : defaultModel.currentSelection()
    const selectionRef: ModelSelectionRef = {
      assembled: undefined,
      current: selection,
    }
    const setup = (agentCtx: Context) => {
      installModelSelection(agentCtx, selectionRef)
    }
    const agentOptions = {
      model: selection.model,
      provider: selection.provider,
    }
    const handle: AgentHandle = options.request.kind !== 'resume'
      ? await agents.create({
          agentOptions,
          meta: {
            cwd: options.request.cwd,
            ...(options.request.kind === 'fork'
              ? {
                  parentSession: SessionId(options.request.parentSessionId),
                  seedLength: options.request.seed.length,
                }
              : {}),
          },
          ...(options.request.kind === 'fork' ? { seed: options.request.seed } : {}),
          sessionId: SessionId(options.request.sessionId),
          setup,
          signal: lifecycleAbort.signal,
        })
      : await agents.resume({
          agentOptions,
          resumeSessionId: SessionId(options.request.sessionId),
          setup,
          signal: lifecycleAbort.signal,
        })

    owner.own('AgentHandle', () => handle.dispose())
    throwIfAborted(lifecycleAbort.signal)

    const pumpOptions: AgentAttachmentOptions = {
      ...options,
      signal: lifecycleAbort.signal,
    }
    const eventPump = new SessionEventPump(ctx, handle.agent, pumpOptions, batchSize)
    owner.own('session event pump', () => eventPump.dispose())
    options.onAttached?.(handle.agent)
    owner.own('attachment abort signal', () => {
      options.signal.removeEventListener('abort', forwardAbort)
      lifecycleAbort.abort()
    })

    await eventPump.replay()
    throwIfAborted(lifecycleAbort.signal)

    return {
      agent: handle.agent,
      dispose: () => owner.dispose(),
    }
  } catch (error) {
    options.signal.removeEventListener('abort', forwardAbort)
    lifecycleAbort.abort(error)
    try {
      await owner.dispose()
    } catch (cleanupError) {
      throw combineFailure(error, cleanupError)
    }
    throw error
  }
}
