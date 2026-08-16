const DEFAULT_MAX_PENDING_REQUESTS = 4
const DEFAULT_MAX_RESULTS = 100
const MAX_COMPLETION_METADATA_CODE_UNITS = 500
const MAX_COMPLETION_REPLACEMENT_CODE_UNITS = 100_000

type Listener = () => void

export type CompletionKind = 'command' | 'path'

export interface CompletionRequest {
  readonly kind: CompletionKind
  readonly query: string
  readonly signal: AbortSignal
}

export interface CompletionOption {
  readonly description?: string
  readonly id: string
  readonly label: string
  readonly replacement: string
}

export interface CompletionProvider {
  complete(request: CompletionRequest): Promise<readonly CompletionOption[]>
}

export interface CompletionCandidate extends CompletionOption {
  readonly end: number
  readonly kind: CompletionKind
  readonly start: number
}

export interface CompletionContext {
  readonly end: number
  readonly kind: CompletionKind
  readonly query: string
  readonly start: number
}

export interface CompletionSnapshot {
  readonly error?: string
  readonly items: readonly CompletionCandidate[]
  readonly kind?: CompletionKind
  readonly query: string
  readonly revision: number
  readonly selectedIndex?: number
  readonly status: 'error' | 'idle' | 'loading' | 'ready'
  readonly truncated: boolean
}

export interface CompletionControllerOptions {
  readonly maxPendingRequests?: number
  readonly maxResults?: number
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function nextWhitespace(text: string, offset: number): number {
  let end = offset
  while (end < text.length && !/\s/u.test(text[end] as string)) end += 1
  return end
}

export function extractCompletionContext(text: string, cursor: number): CompletionContext | undefined {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length) {
    throw new RangeError('completion cursor must be within the editor text')
  }
  const commandPrefix = text.slice(0, cursor)
  if (/^\/[a-z0-9_-]*$/u.test(commandPrefix)) {
    const end = nextWhitespace(text, cursor)
    if (end === text.length || /^\/[a-z0-9_-]+$/u.test(text.slice(0, end))) {
      return { end, kind: 'command', query: commandPrefix.slice(1), start: 0 }
    }
  }

  let tokenStart = cursor
  while (tokenStart > 0 && !/\s/u.test(text[tokenStart - 1] as string)) tokenStart -= 1
  const explicitReference = text[tokenStart] === '@'
  const query = text.slice(tokenStart + (explicitReference ? 1 : 0), cursor)
  if (!explicitReference && !query.includes('/') && !query.includes('\\')) return undefined
  if (query.includes('\u0000')) return undefined
  return {
    end: nextWhitespace(text, cursor),
    kind: 'path',
    query,
    start: tokenStart + (explicitReference ? 1 : 0),
  }
}

function bounded(value: string, maximum = MAX_COMPLETION_METADATA_CODE_UNITS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function renderError(error: unknown): string {
  try {
    return bounded(error instanceof Error ? error.message : String(error))
  } catch {
    return '<unrenderable completion failure>'
  }
}

function idleSnapshot(revision: number): CompletionSnapshot {
  return Object.freeze({
    items: Object.freeze([]),
    query: '',
    revision,
    status: 'idle',
    truncated: false,
  })
}

export class CompletionController {
  readonly #controllers = new Set<AbortController>()
  readonly #listeners = new Set<Listener>()
  readonly #maxPendingRequests: number
  readonly #maxResults: number
  readonly #provider: CompletionProvider
  readonly #tasks = new Set<Promise<void>>()
  #disposed = false
  #disposing: Promise<void> | undefined
  #generation = 0
  #revision = 0
  #selectedIndex = 0
  #snapshot: CompletionSnapshot = idleSnapshot(0)

  constructor(provider: CompletionProvider, options: CompletionControllerOptions = {}) {
    this.#provider = provider
    this.#maxPendingRequests = positiveLimit(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      'maxPendingRequests',
    )
    this.#maxResults = positiveLimit(options.maxResults, DEFAULT_MAX_RESULTS, 'maxResults')
  }

  getSnapshot = (): CompletionSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  request(text: string, cursor: number): boolean {
    this.#assertActive()
    const context = extractCompletionContext(text, cursor)
    if (context === undefined) {
      this.cancel()
      return false
    }
    this.#generation += 1
    const generation = this.#generation
    for (const controller of this.#controllers) {
      controller.abort(new Error('Completion superseded by a newer request'))
    }
    if (this.#tasks.size >= this.#maxPendingRequests) {
      this.#publish({
        error: 'Previous completion requests are still settling',
        items: Object.freeze([]),
        kind: context.kind,
        query: context.query,
        status: 'error',
        truncated: false,
      })
      return true
    }
    const controller = new AbortController()
    this.#controllers.add(controller)
    this.#selectedIndex = 0
    this.#publish({
      items: Object.freeze([]),
      kind: context.kind,
      query: context.query,
      status: 'loading',
      truncated: false,
    })
    const task = Promise.resolve().then(() => this.#provider.complete({
      kind: context.kind,
      query: context.query,
      signal: controller.signal,
    })).then(
      (options) => {
        if (this.#disposed || controller.signal.aborted || generation !== this.#generation) return
        const seen = new Set<string>()
        const candidates: CompletionCandidate[] = []
        const scanLimit = Math.min(options.length, this.#maxResults * 10)
        for (let index = 0; index < scanLimit; index += 1) {
          const option = options[index]
          if (option === undefined) continue
          if (
            option.id.length > MAX_COMPLETION_METADATA_CODE_UNITS
            || seen.has(option.id)
            || option.replacement.includes('\u0000')
            || option.replacement.length > MAX_COMPLETION_REPLACEMENT_CODE_UNITS
          ) {
            continue
          }
          seen.add(option.id)
          candidates.push(Object.freeze({
            ...(option.description === undefined
              ? {}
              : { description: bounded(option.description) }),
            end: context.end,
            id: option.id,
            kind: context.kind,
            label: bounded(option.label),
            replacement: option.replacement,
            start: context.start,
          }))
          if (candidates.length >= this.#maxResults) break
        }
        this.#publish({
          items: Object.freeze(candidates),
          kind: context.kind,
          query: context.query,
          status: 'ready',
          truncated: options.length > candidates.length,
        })
      },
      (error: unknown) => {
        if (this.#disposed || controller.signal.aborted || generation !== this.#generation) return
        this.#publish({
          error: renderError(error),
          items: Object.freeze([]),
          kind: context.kind,
          query: context.query,
          status: 'error',
          truncated: false,
        })
      },
    ).finally(() => {
      this.#controllers.delete(controller)
      this.#tasks.delete(task)
    })
    this.#tasks.add(task)
    return true
  }

  cancel(): boolean {
    this.#assertActive()
    const changed = this.#snapshot.status !== 'idle' || this.#tasks.size > 0
    this.#generation += 1
    for (const controller of this.#controllers) {
      controller.abort(new Error('Completion cancelled'))
    }
    if (changed) this.#publishIdle()
    return changed
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    const count = this.#snapshot.items.length
    if (count < 2) return false
    this.#selectedIndex = direction === 'down'
      ? (this.#selectedIndex + 1) % count
      : (this.#selectedIndex - 1 + count) % count
    this.#publish({
      items: this.#snapshot.items,
      ...(this.#snapshot.kind === undefined ? {} : { kind: this.#snapshot.kind }),
      query: this.#snapshot.query,
      status: this.#snapshot.status,
      truncated: this.#snapshot.truncated,
    })
    return true
  }

  selected(): CompletionCandidate | undefined {
    return this.#snapshot.items[this.#selectedIndex]
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    this.#generation += 1
    for (const controller of this.#controllers) {
      controller.abort(new Error('Completion controller disposed'))
    }
    this.#listeners.clear()
    await Promise.all([...this.#tasks])
    this.#controllers.clear()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('CompletionController is disposed')
  }

  #publish(
    state: Omit<CompletionSnapshot, 'revision' | 'selectedIndex'>,
  ): void {
    this.#revision += 1
    this.#snapshot = Object.freeze({
      ...state,
      revision: this.#revision,
      ...(state.items.length === 0 ? {} : { selectedIndex: this.#selectedIndex }),
    })
    for (const listener of this.#listeners) listener()
  }

  #publishIdle(): void {
    this.#revision += 1
    this.#selectedIndex = 0
    this.#snapshot = idleSnapshot(this.#revision)
    for (const listener of this.#listeners) listener()
  }
}
