import type { SessionEvent } from '@deepseek-ai/dsh-session'

import {
  createTranscriptState,
  reduceTranscriptBatch,
  type TranscriptLimits,
  type TranscriptState,
} from './transcript-reducer'

export type TranscriptListener = () => Promise<void> | void
export type TranscriptErrorReporter = (error: unknown) => Promise<void> | void

export interface RepaintScheduler {
  schedule(task: () => void): () => void
}

export interface TranscriptControllerOptions {
  readonly limits?: TranscriptLimits
  readonly reportError?: TranscriptErrorReporter
  readonly scheduler?: RepaintScheduler
}

export interface TranscriptStore {
  readonly getSnapshot: () => TranscriptState
  readonly subscribe: (listener: TranscriptListener) => () => void
}

const immediateScheduler: RepaintScheduler = {
  schedule(task) {
    const handle = setImmediate(task)
    return () => {
      clearImmediate(handle)
    }
  },
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('Transcript event consumption was aborted', { cause: reason })
  error.name = 'AbortError'
  return error
}

function disposedError(): Error {
  return new Error('Transcript controller is disposed')
}

export class TranscriptController implements TranscriptStore {
  readonly #listeners = new Set<TranscriptListener>()
  readonly #reportError: TranscriptErrorReporter
  readonly #failures: unknown[] = []
  readonly #reports = new Set<Promise<void>>()
  readonly #scheduler: RepaintScheduler
  #cancelRepaint: (() => void) | undefined
  #disposed = false
  #disposing: Promise<void> | undefined
  #state: TranscriptState

  constructor(options: TranscriptControllerOptions = {}) {
    this.#state = createTranscriptState(options.limits)
    this.#reportError = options.reportError ?? ((error) => {
      this.#failures.push(
        new Error('Transcript listener failed without an error reporter', { cause: error }),
      )
    })
    this.#scheduler = options.scheduler ?? immediateScheduler
  }

  readonly getSnapshot = (): TranscriptState => this.#state

  readonly subscribe = (listener: TranscriptListener): (() => void) => {
    if (this.#disposed) throw disposedError()
    this.#listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.#listeners.delete(listener)
    }
  }

  readonly accept = (
    events: readonly SessionEvent[],
    signal?: AbortSignal,
  ): void => {
    if (this.#disposed) throw disposedError()
    if (signal?.aborted === true) throw abortError(signal.reason)

    const next = reduceTranscriptBatch(this.#state, events)
    if (next === this.#state) return
    this.#state = next
    this.#scheduleRepaint()
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    try {
      this.#cancelRepaint?.()
    } catch (error) {
      this.#failures.push(error)
    }
    this.#cancelRepaint = undefined
    this.#listeners.clear()
    while (this.#reports.size > 0) {
      await Promise.all([...this.#reports])
    }
    if (this.#failures.length > 0) {
      throw new AggregateError(
        this.#failures,
        'Transcript controller did not dispose cleanly',
      )
    }
  }

  #scheduleRepaint(): void {
    if (this.#cancelRepaint !== undefined) return
    this.#cancelRepaint = this.#scheduler.schedule(() => {
      this.#cancelRepaint = undefined
      if (this.#disposed) return
      for (const listener of [...this.#listeners]) {
        try {
          const result = listener()
          if (result !== undefined) {
            this.#trackReport(Promise.resolve(result).catch((error: unknown) => {
              this.#reportListenerError(error)
            }))
          }
        } catch (error) {
          this.#reportListenerError(error)
        }
      }
    })
  }

  #reportListenerError(error: unknown): void {
    try {
      const result = this.#reportError(error)
      if (result !== undefined) {
        this.#trackReport(Promise.resolve(result).catch((reportError: unknown) => {
          this.#failures.push(
            new AggregateError(
              [error, reportError],
              'Transcript listener and its error reporter both failed',
            ),
          )
        }))
      }
    } catch (reportError) {
      this.#failures.push(
        new AggregateError(
          [error, reportError],
          'Transcript listener and its error reporter both failed',
        ),
      )
    }
  }

  #trackReport(task: Promise<void>): void {
    this.#reports.add(task)
    const remove = () => {
      this.#reports.delete(task)
    }
    void task.then(remove, remove)
  }
}
