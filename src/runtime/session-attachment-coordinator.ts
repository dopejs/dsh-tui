type Listener = () => void

export interface SwitchableSessionBinding {
  readonly sessionId: string
  dispose(): Promise<void>
  setAcceptingInput(accepting: boolean): void
}

export interface SessionBindingFactory<TBinding extends SwitchableSessionBinding> {
  preflight(sessionId: string, signal: AbortSignal): Promise<void>
  resume(sessionId: string, signal: AbortSignal): Promise<TBinding>
}

export type SessionBindingCreator<TBinding extends SwitchableSessionBinding> = (
  signal: AbortSignal,
) => Promise<TBinding>

export interface SessionAttachmentSnapshot<TBinding extends SwitchableSessionBinding> {
  readonly binding?: TBinding
  readonly error?: string
  readonly revision: number
  readonly status: 'attached' | 'failed' | 'switching'
  readonly targetSessionId?: string
}

export interface SessionAttachmentCoordinatorOptions<TBinding extends SwitchableSessionBinding> {
  readonly factory: SessionBindingFactory<TBinding>
  readonly initial: TBinding
  readonly onFatal: (error: unknown) => Promise<void> | void
  readonly signal: AbortSignal
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Session attachment transition aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return error
}

function renderError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<unrenderable session transition failure>'
  }
}

function isExpectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (
    error === signal.reason
    || (error instanceof Error && error.name === 'AbortError')
  )
}

export class SessionAttachmentCoordinator<TBinding extends SwitchableSessionBinding> {
  readonly #factory: SessionBindingFactory<TBinding>
  readonly #lifecycleAbort = new AbortController()
  readonly #listeners = new Set<Listener>()
  readonly #onFatal: SessionAttachmentCoordinatorOptions<TBinding>['onFatal']
  readonly #signal: AbortSignal
  readonly #stopForwarding: () => void
  #binding: TBinding | undefined
  #disposed = false
  #disposing: Promise<void> | undefined
  #error: string | undefined
  #revision = 0
  #snapshot: SessionAttachmentSnapshot<TBinding>
  #status: SessionAttachmentSnapshot<TBinding>['status'] = 'attached'
  #targetSessionId: string | undefined
  #transition: Promise<void> | undefined

  constructor(options: SessionAttachmentCoordinatorOptions<TBinding>) {
    this.#factory = options.factory
    this.#binding = options.initial
    this.#onFatal = options.onFatal
    this.#signal = options.signal
    const forwardAbort = () => {
      this.#lifecycleAbort.abort(options.signal.reason)
    }
    options.signal.addEventListener('abort', forwardAbort, { once: true })
    this.#stopForwarding = () => {
      options.signal.removeEventListener('abort', forwardAbort)
    }
    if (options.signal.aborted) forwardAbort()
    this.#snapshot = this.#createSnapshot()
  }

  getSnapshot = (): SessionAttachmentSnapshot<TBinding> => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  switchSession(sessionId: string, signal: AbortSignal): Promise<void> {
    return this.#startTransition(
      sessionId,
      signal,
      transitionSignal => this.#factory.preflight(sessionId, transitionSignal),
      transitionSignal => this.#factory.resume(sessionId, transitionSignal),
    )
  }

  createSession(
    sessionId: string,
    create: SessionBindingCreator<TBinding>,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#startTransition(
      sessionId,
      signal,
      () => Promise.resolve(),
      transitionSignal => create(transitionSignal),
    )
  }

  #startTransition(
    sessionId: string,
    signal: AbortSignal,
    preflight: (signal: AbortSignal) => Promise<void>,
    attach: (signal: AbortSignal) => Promise<TBinding>,
  ): Promise<void> {
    this.#assertActive()
    if (this.#binding?.sessionId === sessionId && this.#transition === undefined) {
      return Promise.resolve()
    }
    if (this.#transition !== undefined) {
      return Promise.reject(new Error('Another session transition is already running'))
    }
    const transitionAbort = new AbortController()
    const forwardCaller = () => transitionAbort.abort(signal.reason)
    const forwardLifecycle = () => transitionAbort.abort(this.#lifecycleAbort.signal.reason)
    signal.addEventListener('abort', forwardCaller, { once: true })
    this.#lifecycleAbort.signal.addEventListener('abort', forwardLifecycle, { once: true })
    if (signal.aborted) forwardCaller()
    if (this.#lifecycleAbort.signal.aborted) forwardLifecycle()
    const task = this.#performSwitch(
      sessionId,
      transitionAbort.signal,
      preflight,
      attach,
    ).finally(() => {
      signal.removeEventListener('abort', forwardCaller)
      this.#lifecycleAbort.signal.removeEventListener('abort', forwardLifecycle)
      if (this.#transition === task) this.#transition = undefined
    })
    this.#transition = task
    return task
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    this.#stopForwarding()
    this.#lifecycleAbort.abort(new Error('Session attachment coordinator disposed'))
    this.#listeners.clear()
    const failures: unknown[] = []
    try {
      await this.#transition
    } catch (error) {
      if (!isExpectedAbort(error, this.#lifecycleAbort.signal)) failures.push(error)
    }
    const binding = this.#binding
    this.#binding = undefined
    if (binding !== undefined) {
      try {
        await binding.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Session attachment coordinator did not dispose cleanly')
    }
  }

  async #performSwitch(
    sessionId: string,
    signal: AbortSignal,
    preflight: (signal: AbortSignal) => Promise<void>,
    attach: (signal: AbortSignal) => Promise<TBinding>,
  ): Promise<void> {
    if (signal.aborted) throw abortError(signal)
    const previous = this.#binding
    if (previous === undefined) throw new Error('No attached session is available to switch')

    this.#status = 'switching'
    this.#targetSessionId = sessionId
    this.#error = undefined
    previous.setAcceptingInput(false)
    this.#publish()
    try {
      await preflight(signal)
      if (signal.aborted) throw abortError(signal)
    } catch (error) {
      previous.setAcceptingInput(true)
      this.#status = 'attached'
      this.#targetSessionId = undefined
      this.#error = renderError(error)
      this.#publish()
      throw error
    }
    try {
      await previous.dispose()
    } catch (error) {
      this.#status = 'failed'
      this.#error = renderError(error)
      this.#publish()
      await this.#reportFatal(error)
      throw error
    }
    this.#binding = undefined
    this.#publish()

    let unsafeToRestore = false
    try {
      if (signal.aborted) throw abortError(signal)
      const next = await attach(signal)
      if (signal.aborted) {
        try {
          await next.dispose()
        } catch (cleanupError) {
          unsafeToRestore = true
          throw new AggregateError(
            [abortError(signal), cleanupError],
            'Aborted target session could not be disposed safely',
            { cause: cleanupError },
          )
        }
        throw abortError(signal)
      }
      this.#binding = next
      this.#status = 'attached'
      this.#targetSessionId = undefined
      this.#publish()
    } catch (switchError) {
      if (unsafeToRestore) {
        this.#status = 'failed'
        this.#targetSessionId = undefined
        this.#error = renderError(switchError)
        this.#publish()
        await this.#reportFatal(switchError)
        throw switchError
      }
      if (this.#disposed || this.#signal.aborted || this.#lifecycleAbort.signal.aborted) {
        this.#status = 'failed'
        this.#error = renderError(switchError)
        this.#publish()
        throw switchError
      }
      try {
        const restored = await this.#factory.resume(
          previous.sessionId,
          this.#lifecycleAbort.signal,
        )
        this.#binding = restored
        this.#status = 'attached'
        this.#targetSessionId = undefined
        this.#error = renderError(switchError)
        this.#publish()
      } catch (restoreError) {
        const aggregate = new AggregateError(
          [switchError, restoreError],
          'Target session failed to resume and the previous session could not be restored',
        )
        this.#status = 'failed'
        this.#targetSessionId = undefined
        this.#error = aggregate.message
        this.#publish()
        await this.#reportFatal(aggregate)
        throw aggregate
      }
      throw switchError
    }
  }

  async #reportFatal(error: unknown): Promise<void> {
    try {
      await this.#onFatal(error)
    } catch (reportError) {
      throw new AggregateError(
        [error, reportError],
        'Session transition and fatal-error reporting both failed',
        { cause: reportError },
      )
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('SessionAttachmentCoordinator is disposed')
  }

  #createSnapshot(): SessionAttachmentSnapshot<TBinding> {
    return Object.freeze({
      ...(this.#binding === undefined ? {} : { binding: this.#binding }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      revision: this.#revision,
      status: this.#status,
      ...(this.#targetSessionId === undefined
        ? {}
        : { targetSessionId: this.#targetSessionId }),
    })
  }

  #publish(): void {
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of this.#listeners) listener()
  }
}
