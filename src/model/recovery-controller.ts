const DEFAULT_MAX_DESTINATION_CODE_UNITS = 4_096
const MAX_RESULT_CODE_UNITS = 2_000

type Listener = () => void

export type RecoveryCapabilityId = 'durability' | 'export' | 'file-rewind' | 'fork'

export interface RecoveryCapability {
  readonly available: boolean
  readonly detail: string
  readonly id: RecoveryCapabilityId
  readonly title: string
}

export interface RecoveryExportResult {
  readonly codeUnits: number
  readonly path: string
}

export interface RecoveryForkResult {
  readonly boundary: number
  readonly sessionId: string
}

export interface RecoveryOperations {
  readonly exportRaw?: (
    destination: string,
    signal: AbortSignal,
  ) => Promise<RecoveryExportResult>
  readonly flush: (signal: AbortSignal) => Promise<boolean>
  readonly fork: (signal: AbortSignal) => Promise<RecoveryForkResult>
}

export interface RecoveryControllerOptions {
  readonly exportDetail?: string
  readonly forkDetail?: string
  readonly maxDestinationCodeUnits?: number
  readonly operations: RecoveryOperations
  readonly sessionId: string
  readonly suggestedExportDestination: string
}

export interface RecoverySnapshot {
  readonly activeOperation?: Exclude<RecoveryCapabilityId, 'file-rewind'>
  readonly capabilities: readonly RecoveryCapability[]
  readonly destination: string
  readonly error?: string
  readonly result?: string
  readonly revision: number
  readonly selectedIndex: number
  readonly sessionId: string
  readonly status: 'confirming-fork' | 'error' | 'export-input' | 'idle' | 'running' | 'success'
  readonly suggestedExportDestination: string
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function renderError(error: unknown): string {
  let rendered: string
  try {
    rendered = error instanceof Error ? error.message : String(error)
  } catch {
    rendered = '<unrenderable recovery failure>'
  }
  return rendered.length <= MAX_RESULT_CODE_UNITS
    ? rendered
    : `${rendered.slice(0, MAX_RESULT_CODE_UNITS - 1)}…`
}

export class RecoveryController {
  readonly #capabilities: readonly RecoveryCapability[]
  readonly #listeners = new Set<Listener>()
  readonly #maxDestinationCodeUnits: number
  readonly #operations: RecoveryOperations
  readonly #sessionId: string
  readonly #suggestedExportDestination: string
  #activeOperation: RecoverySnapshot['activeOperation']
  #destination = ''
  #disposed = false
  #error: string | undefined
  #operationAbort: AbortController | undefined
  #operationTask: Promise<void> | undefined
  #result: string | undefined
  #revision = 0
  #selectedIndex = 0
  #snapshot: RecoverySnapshot
  #status: RecoverySnapshot['status'] = 'idle'

  constructor(options: RecoveryControllerOptions) {
    this.#operations = options.operations
    this.#sessionId = options.sessionId
    this.#suggestedExportDestination = options.suggestedExportDestination
    this.#maxDestinationCodeUnits = positiveLimit(
      options.maxDestinationCodeUnits,
      DEFAULT_MAX_DESTINATION_CODE_UNITS,
      'maxDestinationCodeUnits',
    )
    this.#capabilities = Object.freeze([
      Object.freeze({
        available: true,
        detail: 'Await every registered persistence listener for the exact live session.',
        id: 'durability' as const,
        title: 'Durable session barrier',
      }),
      Object.freeze({
        available: options.operations.exportRaw !== undefined,
        detail: options.exportDetail
          ?? (options.operations.exportRaw === undefined
            ? 'The configured backend has no verbatim per-session artifact.'
            : 'Export the backend-owned raw artifact without overwriting an existing file.'),
        id: 'export' as const,
        title: 'Raw session export',
      }),
      Object.freeze({
        available: true,
        detail: options.forkDetail
          ?? 'Create a child conversation from the current balanced durable boundary and switch to it.',
        id: 'fork' as const,
        title: 'Conversation fork',
      }),
      Object.freeze({
        available: false,
        detail: 'Unavailable on Harness rc.6: no public owner can prove or restore arbitrary file mutations.',
        id: 'file-rewind' as const,
        title: 'File rewind',
      }),
    ])
    this.#snapshot = this.#createSnapshot()
  }

  readonly getSnapshot = (): RecoverySnapshot => this.#snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#status === 'running') return false
    const next = Math.max(0, Math.min(
      this.#capabilities.length - 1,
      this.#selectedIndex + (direction === 'down' ? 1 : -1),
    ))
    if (next === this.#selectedIndex) return false
    this.#selectedIndex = next
    this.#resetTransient()
    this.#publish()
    return true
  }

  activateSelected(): 'busy' | 'confirmation-required' | 'input-required' | 'started' | 'unavailable' {
    this.#assertActive()
    if (this.#status === 'running') return 'busy'
    const selected = this.#capabilities[this.#selectedIndex]
    if (selected === undefined || !selected.available) return 'unavailable'
    this.#resetTransient()
    if (selected.id === 'export') {
      this.#status = 'export-input'
      this.#publish()
      return 'input-required'
    }
    if (selected.id === 'fork') {
      this.#status = 'confirming-fork'
      this.#publish()
      return 'confirmation-required'
    }
    if (selected.id === 'durability') {
      this.#run('durability', async (signal) => {
        const participated = await this.#operations.flush(signal)
        if (!participated) throw new Error('No durability listener participated in the session barrier')
        return 'Durable session barrier completed.'
      })
      return 'started'
    }
    return 'unavailable'
  }

  insertDestination(value: string): 'applied' | 'limit-exceeded' | 'unchanged' {
    this.#assertActive()
    if (this.#status !== 'export-input' || value === '') return 'unchanged'
    if (this.#destination.length + value.length > this.#maxDestinationCodeUnits) {
      return 'limit-exceeded'
    }
    this.#destination += value
    this.#publish()
    return 'applied'
  }

  backspaceDestination(): boolean {
    this.#assertActive()
    if (this.#status !== 'export-input' || this.#destination === '') return false
    this.#destination = Array.from(this.#destination).slice(0, -1).join('')
    this.#publish()
    return true
  }

  confirm(): boolean {
    this.#assertActive()
    if (this.#status === 'export-input') {
      const exportRaw = this.#operations.exportRaw
      if (exportRaw === undefined) return false
      const destination = this.#destination.trim() || this.#suggestedExportDestination
      this.#run('export', async (signal) => {
        const exported = await exportRaw(destination, signal)
        return `Exported ${String(exported.codeUnits)} code units to ${exported.path}`
      })
      return true
    }
    if (this.#status === 'confirming-fork') {
      this.#run('fork', async (signal) => {
        const forked = await this.#operations.fork(signal)
        return `Forking ${forked.sessionId} at event ${String(forked.boundary)}…`
      })
      return true
    }
    return false
  }

  cancelMode(): boolean {
    this.#assertActive()
    if (this.#status !== 'export-input' && this.#status !== 'confirming-fork') return false
    this.#destination = ''
    this.#status = 'idle'
    this.#publish()
    return true
  }

  cancelOperation(): boolean {
    this.#assertActive()
    if (this.#status !== 'running' || this.#operationAbort === undefined) return false
    this.#operationAbort.abort(new Error('Recovery operation cancelled'))
    return true
  }

  dispose(): Promise<void> {
    if (this.#disposed) return this.#operationTask ?? Promise.resolve()
    this.#disposed = true
    this.#operationAbort?.abort(new Error('Recovery controller disposed'))
    this.#listeners.clear()
    return this.#operationTask ?? Promise.resolve()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('RecoveryController is disposed')
  }

  #createSnapshot(): RecoverySnapshot {
    return Object.freeze({
      ...(this.#activeOperation === undefined ? {} : { activeOperation: this.#activeOperation }),
      capabilities: this.#capabilities,
      destination: this.#destination,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      ...(this.#result === undefined ? {} : { result: this.#result }),
      revision: this.#revision,
      selectedIndex: this.#selectedIndex,
      sessionId: this.#sessionId,
      status: this.#status,
      suggestedExportDestination: this.#suggestedExportDestination,
    })
  }

  #publish(): void {
    if (this.#disposed) return
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of this.#listeners) listener()
  }

  #resetTransient(): void {
    this.#destination = ''
    this.#error = undefined
    this.#result = undefined
    this.#status = 'idle'
  }

  #run(
    operation: Exclude<RecoveryCapabilityId, 'file-rewind'>,
    run: (signal: AbortSignal) => Promise<string>,
  ): void {
    const abort = new AbortController()
    this.#operationAbort = abort
    this.#activeOperation = operation
    this.#error = undefined
    this.#result = undefined
    this.#status = 'running'
    this.#publish()
    const task = run(abort.signal).then(
      (result) => {
        if (this.#disposed || abort.signal.aborted) return
        this.#result = result.length <= MAX_RESULT_CODE_UNITS
          ? result
          : `${result.slice(0, MAX_RESULT_CODE_UNITS - 1)}…`
        this.#status = 'success'
      },
      (error: unknown) => {
        if (this.#disposed && abort.signal.aborted) return
        this.#error = renderError(error)
        this.#status = 'error'
      },
    ).finally(() => {
      if (this.#operationTask === task) this.#operationTask = undefined
      if (this.#operationAbort === abort) this.#operationAbort = undefined
      this.#activeOperation = undefined
      this.#publish()
    })
    this.#operationTask = task
  }
}
