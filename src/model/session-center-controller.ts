import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

const DEFAULT_MAX_RESULTS = 100
const DEFAULT_MAX_SESSIONS = 1_000
const DEFAULT_MAX_QUERY_CODE_UNITS = 1_000
const DEFAULT_MAX_PENDING_OPERATIONS = 4
const MAX_ERROR_CODE_UNITS = 500

type Listener = () => void

export interface SessionPersistenceReader {
  inspect(id: SessionId, signal?: AbortSignal): Promise<{
    readonly events: readonly SessionEvent[]
    readonly meta: SessionHeader
  }>
  list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
}

export interface SessionSwitchTarget {
  switchSession(sessionId: string, signal: AbortSignal): Promise<void>
}

export interface SessionCenterItem {
  readonly agentPreset?: string
  readonly createdAt: number
  readonly cwd?: string
  readonly delegationDepth?: number
  readonly id: string
  readonly isCurrent: boolean
  readonly parentSession?: string
}

export interface SessionPreview {
  readonly eventCount: number
  readonly id: string
  readonly lastEventType?: string
}

export interface SessionCenterSnapshot {
  readonly catalogTruncated: boolean
  readonly error?: string
  readonly items: readonly SessionCenterItem[]
  readonly preview?: SessionPreview
  readonly query: string
  readonly revision: number
  readonly selectedIndex?: number
  readonly status: 'error' | 'idle' | 'loading' | 'previewing' | 'ready' | 'switching'
  readonly totalMatches: number
}

export interface SessionCenterControllerOptions {
  readonly currentSessionId: string
  readonly maxQueryCodeUnits?: number
  readonly maxPendingOperations?: number
  readonly maxResults?: number
  readonly maxSessions?: number
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function renderError(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error)
    return value.length <= MAX_ERROR_CODE_UNITS
      ? value
      : `${value.slice(0, MAX_ERROR_CODE_UNITS - 1)}…`
  } catch {
    return '<unrenderable session operation failure>'
  }
}

function itemFrom(header: SessionHeader, currentSessionId: string): SessionCenterItem {
  return Object.freeze({
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.delegationDepth === undefined
      ? {}
      : { delegationDepth: header.delegationDepth }),
    id: String(header.id),
    isCurrent: String(header.id) === currentSessionId,
    ...(header.parentSession === undefined
      ? {}
      : { parentSession: String(header.parentSession) }),
  })
}

function searchText(item: SessionCenterItem): string {
  return [item.id, item.cwd, item.parentSession, item.agentPreset]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .toLowerCase()
}

function worseHeader(left: SessionHeader, right: SessionHeader): boolean {
  return left.createdAt < right.createdAt
    || (left.createdAt === right.createdAt && String(left.id).localeCompare(String(right.id), 'en') > 0)
}

function newestHeaders(
  headers: readonly SessionHeader[],
  maximum: number,
): readonly SessionHeader[] {
  const heap: SessionHeader[] = []
  const bubbleUp = (start: number) => {
    let index = start
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      const childValue = heap[index]
      const parentValue = heap[parent]
      if (childValue === undefined || parentValue === undefined || !worseHeader(childValue, parentValue)) {
        break
      }
      heap[index] = parentValue
      heap[parent] = childValue
      index = parent
    }
  }
  const sinkRoot = () => {
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let worst = index
      if (
        heap[left] !== undefined
        && heap[worst] !== undefined
        && worseHeader(heap[left] as SessionHeader, heap[worst] as SessionHeader)
      ) {
        worst = left
      }
      if (
        heap[right] !== undefined
        && heap[worst] !== undefined
        && worseHeader(heap[right] as SessionHeader, heap[worst] as SessionHeader)
      ) {
        worst = right
      }
      if (worst === index) return
      const value = heap[index] as SessionHeader
      heap[index] = heap[worst] as SessionHeader
      heap[worst] = value
      index = worst
    }
  }
  for (const header of headers) {
    if (heap.length < maximum) {
      heap.push(header)
      bubbleUp(heap.length - 1)
    } else if (heap[0] !== undefined && worseHeader(heap[0], header)) {
      heap[0] = header
      sinkRoot()
    }
  }
  return heap
}

export class SessionCenterController {
  readonly #controllers = new Set<AbortController>()
  readonly #listeners = new Set<Listener>()
  readonly #maxQueryCodeUnits: number
  readonly #maxPendingOperations: number
  readonly #maxResults: number
  readonly #maxSessions: number
  readonly #persistence: SessionPersistenceReader
  readonly #switchTarget: SessionSwitchTarget
  readonly #tasks = new Set<Promise<void>>()
  #currentSessionId: string
  #disposed = false
  #disposing: Promise<void> | undefined
  #error: string | undefined
  #generation = 0
  #items: readonly SessionCenterItem[] = Object.freeze([])
  #preview: SessionPreview | undefined
  #query = ''
  #revision = 0
  #selectedIndex = 0
  #snapshot: SessionCenterSnapshot
  #status: SessionCenterSnapshot['status'] = 'idle'
  #catalogTruncated = false

  constructor(
    persistence: SessionPersistenceReader,
    switchTarget: SessionSwitchTarget,
    options: SessionCenterControllerOptions,
  ) {
    this.#persistence = persistence
    this.#switchTarget = switchTarget
    this.#currentSessionId = options.currentSessionId
    this.#maxQueryCodeUnits = positiveLimit(
      options.maxQueryCodeUnits,
      DEFAULT_MAX_QUERY_CODE_UNITS,
      'maxQueryCodeUnits',
    )
    this.#maxPendingOperations = positiveLimit(
      options.maxPendingOperations,
      DEFAULT_MAX_PENDING_OPERATIONS,
      'maxPendingOperations',
    )
    this.#maxResults = positiveLimit(options.maxResults, DEFAULT_MAX_RESULTS, 'maxResults')
    this.#maxSessions = positiveLimit(options.maxSessions, DEFAULT_MAX_SESSIONS, 'maxSessions')
    this.#snapshot = this.#createSnapshot()
  }

  getSnapshot = (): SessionCenterSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  setCurrentSession(sessionId: string): void {
    this.#assertActive()
    if (sessionId === this.#currentSessionId) return
    this.#currentSessionId = sessionId
    this.#items = Object.freeze(this.#items.map(item => Object.freeze({
      ...item,
      isCurrent: item.id === sessionId,
    })))
    this.#publish()
  }

  resetQuery(): void {
    this.#assertActive()
    this.#query = ''
    this.#selectedIndex = 0
    this.#preview = undefined
    this.#publish()
  }

  insertQuery(value: string): 'applied' | 'limit-exceeded' | 'unchanged' {
    this.#assertActive()
    if (value === '') return 'unchanged'
    if (this.#query.length + value.length > this.#maxQueryCodeUnits) return 'limit-exceeded'
    this.#query += value
    this.#selectedIndex = 0
    this.#preview = undefined
    this.#publish()
    return 'applied'
  }

  backspaceQuery(): boolean {
    this.#assertActive()
    if (this.#query === '') return false
    const characters = Array.from(this.#query)
    characters.pop()
    this.#query = characters.join('')
    this.#selectedIndex = 0
    this.#preview = undefined
    this.#publish()
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    const count = this.#snapshot.items.length
    if (count < 2 || this.#status === 'switching') return false
    this.#selectedIndex = direction === 'down'
      ? (this.#selectedIndex + 1) % count
      : (this.#selectedIndex - 1 + count) % count
    this.#preview = undefined
    this.#publish()
    return true
  }

  selected(): SessionCenterItem | undefined {
    return this.#snapshot.items[this.#selectedIndex]
  }

  refresh(): void {
    this.#assertActive()
    this.#preview = undefined
    this.#start('loading', async (signal) => {
      const headers = await this.#persistence.list(signal)
      if (signal.aborted) return
      this.#catalogTruncated = headers.length > this.#maxSessions
      this.#items = Object.freeze(newestHeaders(headers, this.#maxSessions)
        .map(header => itemFrom(header, this.#currentSessionId))
        .sort((left, right) => right.createdAt - left.createdAt
          || left.id.localeCompare(right.id, 'en')))
      this.#selectedIndex = Math.min(
        this.#selectedIndex,
        Math.max(0, this.#filteredItems(false).length - 1),
      )
      this.#preview = undefined
    })
  }

  inspectSelected(): boolean {
    this.#assertActive()
    const selected = this.selected()
    if (selected === undefined || this.#status === 'switching') return false
    this.#preview = undefined
    return this.#start('previewing', async (signal) => {
      const inspection = await this.#persistence.inspect(SessionId(selected.id), signal)
      if (signal.aborted) return
      const lastEvent = inspection.events.at(-1)
      this.#preview = Object.freeze({
        eventCount: inspection.events.length,
        id: String(inspection.meta.id),
        ...(lastEvent === undefined ? {} : { lastEventType: lastEvent.type }),
      })
    })
  }

  resumeSelected(): boolean {
    this.#assertActive()
    const selected = this.selected()
    if (selected === undefined || selected.isCurrent || this.#status === 'switching') return false
    this.#preview = undefined
    return this.#start('switching', async (signal) => {
      await this.#switchTarget.switchSession(selected.id, signal)
      if (signal.aborted) return
      this.#currentSessionId = selected.id
      this.#items = Object.freeze(this.#items.map(item => Object.freeze({
        ...item,
        isCurrent: item.id === selected.id,
      })))
      this.#preview = undefined
    })
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    this.#generation += 1
    for (const controller of this.#controllers) {
      controller.abort(new Error('Session center disposed'))
    }
    this.#listeners.clear()
    await Promise.all([...this.#tasks])
    this.#controllers.clear()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('SessionCenterController is disposed')
  }

  #createSnapshot(): SessionCenterSnapshot {
    const matches = this.#filteredItems()
    return Object.freeze({
      catalogTruncated: this.#catalogTruncated,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      items: Object.freeze(matches),
      ...(this.#preview === undefined ? {} : { preview: this.#preview }),
      query: this.#query,
      revision: this.#revision,
      ...(matches.length === 0 ? {} : { selectedIndex: this.#selectedIndex }),
      status: this.#status,
      totalMatches: this.#filteredItems(false).length,
    })
  }

  #filteredItems(limit = true): SessionCenterItem[] {
    const query = this.#query.toLowerCase()
    const matches = query === ''
      ? [...this.#items]
      : this.#items.filter(item => searchText(item).includes(query))
    return limit ? matches.slice(0, this.#maxResults) : matches
  }

  #publish(): void {
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of this.#listeners) listener()
  }

  #start(
    status: Exclude<SessionCenterSnapshot['status'], 'error' | 'idle' | 'ready'>,
    operation: (signal: AbortSignal) => Promise<void>,
  ): boolean {
    this.#generation += 1
    const generation = this.#generation
    for (const controller of this.#controllers) {
      controller.abort(new Error('Session operation superseded'))
    }
    if (this.#tasks.size >= this.#maxPendingOperations) {
      this.#status = 'error'
      this.#error = 'Previous session operations are still settling'
      this.#publish()
      return false
    }
    const controller = new AbortController()
    this.#controllers.add(controller)
    this.#status = status
    this.#error = undefined
    this.#publish()
    let result: Promise<void>
    try {
      result = operation(controller.signal)
    } catch (error) {
      result = Promise.reject(error)
    }
    const task = result.then(
      () => {
        if (this.#disposed || controller.signal.aborted || generation !== this.#generation) return
        this.#status = 'ready'
        this.#publish()
      },
      (error: unknown) => {
        if (this.#disposed || controller.signal.aborted || generation !== this.#generation) return
        this.#status = 'error'
        this.#error = renderError(error)
        this.#publish()
      },
    ).finally(() => {
      this.#controllers.delete(controller)
      this.#tasks.delete(task)
    })
    this.#tasks.add(task)
    return true
  }
}
