const DEFAULT_MAX_CHANGES = 500
const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_TEXT_CODE_UNITS = 100_000
const DEFAULT_MAX_METADATA_CODE_UNITS = 1_000
const MAX_ID_CODE_UNITS = 1_000

type Listener = () => void

export type ChangePhase = 'applied' | 'failed' | 'planned' | 'unverified'

export interface ChangeDiffInput {
  readonly newText: string
  readonly oldText: string | null
  readonly path: string
}

export interface ChangePresentationIntent {
  readonly callId: string
  readonly diffs: readonly ChangeDiffInput[]
  readonly eventSeq: number
  readonly phase: ChangePhase
  readonly rowId: string
  readonly title: string
}

export interface IndexedChange {
  readonly callId: string
  readonly eventSeq: number
  readonly expanded: boolean
  readonly id: string
  readonly newText: string
  readonly oldText: string | null
  readonly path: string
  readonly phase: ChangePhase
  readonly rowId: string
  readonly title: string
  readonly truncated: boolean
}

export interface ChangeFileGroup {
  readonly changes: readonly IndexedChange[]
  readonly path: string
}

export interface ChangeIndexSnapshot {
  readonly droppedChanges: number
  readonly groups: readonly ChangeFileGroup[]
  readonly invalidDiffs: number
  readonly revision: number
  readonly selectedIndex?: number
  readonly totalChanges: number
  readonly truncated: boolean
}

export interface ChangeIndexControllerOptions {
  readonly maxChanges?: number
  readonly maxFiles?: number
  readonly maxMetadataCodeUnits?: number
  readonly maxTextCodeUnits?: number
}

interface CallRecord {
  readonly callId: string
  readonly changes: readonly Omit<IndexedChange, 'expanded'>[]
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function boundedText(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false }
  return {
    text: maximum === 1 ? '…' : `${value.slice(0, maximum - 1)}…`,
    truncated: true,
  }
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function changeCount(records: ReadonlyMap<string, CallRecord>): number {
  let total = 0
  for (const record of records.values()) total += record.changes.length
  return total
}

function fileCount(records: ReadonlyMap<string, CallRecord>): number {
  const paths = new Set<string>()
  for (const record of records.values()) {
    for (const change of record.changes) paths.add(change.path)
  }
  return paths.size
}

export class ChangeIndexController {
  readonly #calls = new Map<string, CallRecord>()
  readonly #expanded = new Set<string>()
  readonly #listeners = new Set<Listener>()
  readonly #maxChanges: number
  readonly #maxFiles: number
  readonly #maxMetadataCodeUnits: number
  readonly #maxTextCodeUnits: number
  #disposed = false
  #droppedChanges = 0
  #invalidDiffs = 0
  #revision = 0
  #selectedId: string | undefined
  #snapshot: ChangeIndexSnapshot = Object.freeze({
    droppedChanges: 0,
    groups: Object.freeze([]),
    invalidDiffs: 0,
    revision: 0,
    totalChanges: 0,
    truncated: false,
  })

  constructor(options: ChangeIndexControllerOptions = {}) {
    this.#maxChanges = positiveLimit(options.maxChanges, DEFAULT_MAX_CHANGES, 'maxChanges')
    this.#maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles')
    this.#maxMetadataCodeUnits = positiveLimit(
      options.maxMetadataCodeUnits,
      DEFAULT_MAX_METADATA_CODE_UNITS,
      'maxMetadataCodeUnits',
    )
    this.#maxTextCodeUnits = positiveLimit(
      options.maxTextCodeUnits,
      DEFAULT_MAX_TEXT_CODE_UNITS,
      'maxTextCodeUnits',
    )
  }

  readonly getSnapshot = (): ChangeIndexSnapshot => this.#snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  record(intent: ChangePresentationIntent): void {
    this.#assertActive()
    if (!Array.isArray(intent.diffs)) {
      this.#invalidDiffs = saturatingAdd(this.#invalidDiffs, 1)
      this.#publish()
      return
    }
    if (
      typeof intent.callId !== 'string'
      || intent.callId === ''
      || intent.callId.length > MAX_ID_CODE_UNITS
      || typeof intent.rowId !== 'string'
      || intent.rowId === ''
      || intent.rowId.length > MAX_ID_CODE_UNITS
      || typeof intent.title !== 'string'
      || !(['applied', 'failed', 'planned', 'unverified'] as const).includes(intent.phase)
      || !Number.isSafeInteger(intent.eventSeq)
      || intent.eventSeq < 0
    ) {
      this.#invalidDiffs = saturatingAdd(this.#invalidDiffs, Math.max(1, intent.diffs.length))
      this.#publish()
      return
    }

    const previous = this.#calls.get(intent.callId)
    const title = boundedText(intent.title, this.#maxMetadataCodeUnits)
    const retained: Omit<IndexedChange, 'expanded'>[] = []
    const invalidBefore = this.#invalidDiffs
    const uniquePaths = new Set<string>()
    if (intent.diffs.length > this.#maxChanges) {
      this.#droppedChanges = saturatingAdd(
        this.#droppedChanges,
        intent.diffs.length - this.#maxChanges,
      )
    }
    const inputCount = Math.min(intent.diffs.length, this.#maxChanges)
    for (let index = 0; index < inputCount; index += 1) {
      const candidate: unknown = intent.diffs[index]
      if (
        typeof candidate !== 'object'
        || candidate === null
      ) {
        this.#invalidDiffs = saturatingAdd(this.#invalidDiffs, 1)
        continue
      }
      const diff = candidate as Partial<ChangeDiffInput>
      if (
        typeof diff.path !== 'string'
        || diff.path.trim() === ''
        || typeof diff.newText !== 'string'
        || (diff.oldText !== null && typeof diff.oldText !== 'string')
      ) {
        this.#invalidDiffs = saturatingAdd(this.#invalidDiffs, 1)
        continue
      }
      const path = boundedText(diff.path, this.#maxMetadataCodeUnits)
      if (!uniquePaths.has(path.text) && uniquePaths.size >= this.#maxFiles) {
        this.#droppedChanges = saturatingAdd(this.#droppedChanges, 1)
        continue
      }
      uniquePaths.add(path.text)
      const oldText = diff.oldText === null
        ? undefined
        : boundedText(diff.oldText, this.#maxTextCodeUnits)
      const newText = boundedText(diff.newText, this.#maxTextCodeUnits)
      retained.push(Object.freeze({
        callId: intent.callId,
        eventSeq: intent.eventSeq,
        id: `${intent.callId}:${String(index)}`,
        newText: newText.text,
        oldText: oldText?.text ?? null,
        path: path.text,
        phase: intent.phase,
        rowId: intent.rowId,
        title: title.text,
        truncated: title.truncated || path.truncated || oldText?.truncated === true || newText.truncated,
      }))
    }

    if (
      retained.length === 0
      && intent.diffs.length > 0
      && previous !== undefined
      && this.#invalidDiffs > invalidBefore
    ) {
      retained.push(...previous.changes.map(change => Object.freeze({
        ...change,
        eventSeq: intent.eventSeq,
        phase: intent.phase === 'applied' ? 'unverified' : intent.phase,
        title: title.text,
        truncated: change.truncated || title.truncated,
      })))
    }

    if (previous !== undefined) {
      this.#calls.delete(intent.callId)
      for (const change of previous.changes) this.#expanded.delete(change.id)
    }
    if (retained.length > 0) {
      this.#calls.set(intent.callId, Object.freeze({
        callId: intent.callId,
        changes: Object.freeze(retained),
      }))
    }
    this.#enforceBounds()
    this.#publish()
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    const changes = this.#selectionOrder()
    if (changes.length === 0) return false
    const current = changes.findIndex(change => change.id === this.#selectedId)
    const next = current < 0
      ? 0
      : direction === 'down'
        ? Math.min(changes.length - 1, current + 1)
        : Math.max(0, current - 1)
    const selected = changes[next]?.id
    if (selected === undefined || selected === this.#selectedId) return false
    this.#selectedId = selected
    this.#publish()
    return true
  }

  toggleSelected(): boolean {
    this.#assertActive()
    const selected = this.selected()
    if (selected === undefined) return false
    if (!this.#expanded.delete(selected.id)) this.#expanded.add(selected.id)
    this.#publish()
    return true
  }

  selected(): IndexedChange | undefined {
    const selectedId = this.#selectedId
    if (selectedId === undefined) return undefined
    return this.#selectionOrder().find(change => change.id === selectedId)
  }

  approvalContext(callId: string | undefined): readonly string[] {
    if (callId === undefined) return Object.freeze([])
    const record = this.#calls.get(callId)
    if (record === undefined) return Object.freeze([])
    const planned = record.changes.filter(change => change.phase === 'planned')
    if (planned.length === 0) return Object.freeze([])
    return Object.freeze([
      `Planned changes (${String(planned.length)}):`,
      ...planned.slice(0, 5).map(change => `  ${change.path}`),
      ...(planned.length > 5 ? [`  … ${String(planned.length - 5)} more`] : []),
    ])
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#calls.clear()
    this.#expanded.clear()
    this.#selectedId = undefined
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ChangeIndexController is disposed')
  }

  #enforceBounds(): void {
    while (changeCount(this.#calls) > this.#maxChanges || fileCount(this.#calls) > this.#maxFiles) {
      const oldest = this.#calls.entries().next().value as [string, CallRecord] | undefined
      if (oldest === undefined) break
      this.#calls.delete(oldest[0])
      this.#droppedChanges = saturatingAdd(this.#droppedChanges, oldest[1].changes.length)
      for (const change of oldest[1].changes) this.#expanded.delete(change.id)
    }
  }

  #flatten(): readonly IndexedChange[] {
    return [...this.#calls.values()].flatMap(record => record.changes.map(change => Object.freeze({
      ...change,
      expanded: this.#expanded.has(change.id),
    })))
  }

  #group(changes: readonly IndexedChange[]): readonly ChangeFileGroup[] {
    const groups = new Map<string, IndexedChange[]>()
    for (const change of changes) {
      const group = groups.get(change.path)
      if (group === undefined) groups.set(change.path, [change])
      else group.push(change)
    }
    return Object.freeze([...groups.entries()].map(([path, grouped]) => Object.freeze({
      changes: Object.freeze(grouped),
      path,
    })))
  }

  #selectionOrder(): readonly IndexedChange[] {
    return this.#group(this.#flatten()).flatMap(group => group.changes)
  }

  #publish(): void {
    const changes = this.#flatten()
    if (!changes.some(change => change.id === this.#selectedId)) {
      this.#selectedId = changes[0]?.id
    }
    const groups = this.#group(changes)
    const selectionOrder = groups.flatMap(group => group.changes)
    const selectedIndex = this.#selectedId === undefined
      ? undefined
      : selectionOrder.findIndex(change => change.id === this.#selectedId)
    this.#revision += 1
    this.#snapshot = Object.freeze({
      droppedChanges: this.#droppedChanges,
      groups,
      invalidDiffs: this.#invalidDiffs,
      revision: this.#revision,
      ...(selectedIndex === undefined || selectedIndex < 0 ? {} : { selectedIndex }),
      totalChanges: changes.length,
      truncated: this.#droppedChanges > 0 || changes.some(change => change.truncated),
    })
    for (const listener of this.#listeners) listener()
  }
}
