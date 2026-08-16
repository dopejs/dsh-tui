import type { TranscriptStore } from './transcript-controller'
import type { TranscriptState } from './transcript-reducer'
import type { TranscriptRow } from './view-model'

const DEFAULT_MAX_SEARCH_MATCHES = 200
const DEFAULT_MAX_SEARCH_TEXT_CODE_UNITS = 2_000_000
const DEFAULT_MAX_TOOL_OVERRIDES = 200
const DEFAULT_MAX_SEARCH_QUERY_CODE_UNITS = 1_000
const DEFAULT_PLAIN_TEXT_CODE_UNITS = 1_000_000
const PLAIN_TEXT_TRUNCATION = '\n… [transcript text truncated]'

type Listener = () => void

export interface TranscriptSearchSnapshot {
  readonly activeIndex?: number
  readonly incomplete: boolean
  readonly matchIds: readonly string[]
  readonly open: boolean
  readonly query: string
  readonly totalMatches: number
  readonly truncated: boolean
}

export interface TranscriptViewportSnapshot {
  readonly compactTools: boolean
  readonly evictedWhileDetached: number
  readonly focusedRowId?: string
  readonly followTail: boolean
  readonly historyTruncated: boolean
  readonly revision: number
  readonly scrollOffset: number
  readonly search: TranscriptSearchSnapshot
  readonly unseenRows: number
}

export interface TranscriptViewportControllerOptions {
  readonly maxSearchMatches?: number
  readonly maxSearchQueryCodeUnits?: number
  readonly maxSearchTextCodeUnits?: number
  readonly maxToolOverrides?: number
}

export interface PlainTranscriptText {
  readonly text: string
  readonly truncated: boolean
}

export interface TranscriptRowProjectionOptions {
  readonly maxToolDetailLines?: number
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return limit
}

function rowSearchText(row: TranscriptRow): string {
  return [
    row.content,
    row.toolCard?.title,
    ...(row.toolCard?.lines ?? []),
  ].filter((value): value is string => value !== undefined).join('\n').toLowerCase()
}

function emptySearch(incomplete: boolean): TranscriptSearchSnapshot {
  return Object.freeze({
    incomplete,
    matchIds: Object.freeze([]),
    open: false,
    query: '',
    totalMatches: 0,
    truncated: false,
  })
}

function sameSearch(left: TranscriptSearchSnapshot, right: TranscriptSearchSnapshot): boolean {
  return left.open === right.open
    && left.query === right.query
    && left.activeIndex === right.activeIndex
    && left.incomplete === right.incomplete
    && left.totalMatches === right.totalMatches
    && left.truncated === right.truncated
    && left.matchIds.length === right.matchIds.length
    && left.matchIds.every((id, index) => id === right.matchIds[index])
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function textLabel(row: TranscriptRow): string {
  switch (row.kind) {
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
    case 'tool': return 'Tool'
    case 'user': return 'User'
  }
}

export function projectTranscriptPlainText(
  rows: readonly TranscriptRow[],
  maximumCodeUnits = DEFAULT_PLAIN_TEXT_CODE_UNITS,
): PlainTranscriptText {
  positiveLimit(maximumCodeUnits, DEFAULT_PLAIN_TEXT_CODE_UNITS, 'maximumCodeUnits')
  let text = ''
  for (const row of rows) {
    const heading = row.toolCard?.title ?? row.content
    const details = row.toolCard?.lines ?? []
    const section = [`${textLabel(row)}: ${heading}`, ...details.map(line => `  ${line}`)].join('\n')
    const addition = text === '' ? section : `\n\n${section}`
    if (text.length + addition.length <= maximumCodeUnits) {
      text += addition
      continue
    }
    if (maximumCodeUnits <= PLAIN_TEXT_TRUNCATION.length) {
      return { text: PLAIN_TEXT_TRUNCATION.slice(0, maximumCodeUnits), truncated: true }
    }
    const prefixLength = maximumCodeUnits - PLAIN_TEXT_TRUNCATION.length
    return {
      text: (text + addition).slice(0, prefixLength) + PLAIN_TEXT_TRUNCATION,
      truncated: true,
    }
  }
  return { text, truncated: false }
}

export class TranscriptViewportController {
  readonly #listeners = new Set<Listener>()
  readonly #maxSearchMatches: number
  readonly #maxSearchQueryCodeUnits: number
  readonly #maxSearchTextCodeUnits: number
  readonly #maxToolOverrides: number
  readonly #store: TranscriptStore
  readonly #searchTextCache = new WeakMap<TranscriptRow, string>()
  readonly #toolOverrides = new Set<string>()
  readonly #toolPageOffsets = new Map<string, number>()
  readonly #unsubscribe: () => void
  #compactTools = false
  #disposed = false
  #evictedWhileDetached = 0
  #focusedRowId: string | undefined
  #followTail = true
  #lastDroppedRows: number
  #lastMaterialRows: number
  #revision = 0
  #scrollOffset = 0
  #search: TranscriptSearchSnapshot
  #snapshot: TranscriptViewportSnapshot
  #unseenRows = 0

  constructor(store: TranscriptStore, options: TranscriptViewportControllerOptions = {}) {
    this.#store = store
    this.#maxSearchMatches = positiveLimit(
      options.maxSearchMatches,
      DEFAULT_MAX_SEARCH_MATCHES,
      'maxSearchMatches',
    )
    this.#maxSearchQueryCodeUnits = positiveLimit(
      options.maxSearchQueryCodeUnits,
      DEFAULT_MAX_SEARCH_QUERY_CODE_UNITS,
      'maxSearchQueryCodeUnits',
    )
    this.#maxSearchTextCodeUnits = positiveLimit(
      options.maxSearchTextCodeUnits,
      DEFAULT_MAX_SEARCH_TEXT_CODE_UNITS,
      'maxSearchTextCodeUnits',
    )
    this.#maxToolOverrides = positiveLimit(
      options.maxToolOverrides,
      DEFAULT_MAX_TOOL_OVERRIDES,
      'maxToolOverrides',
    )
    const transcript = store.getSnapshot()
    this.#lastDroppedRows = transcript.droppedRows
    this.#lastMaterialRows = transcript.droppedRows + transcript.rows.length
    this.#search = emptySearch(transcript.droppedRows > 0)
    this.#snapshot = this.#createSnapshot(transcript)
    this.#unsubscribe = store.subscribe(this.#onTranscriptChanged)
  }

  getSnapshot = (): TranscriptViewportSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  scrollLines(lines: number): boolean {
    this.#assertActive()
    if (!Number.isSafeInteger(lines) || lines === 0) return false
    const rows = this.#store.getSnapshot().rows
    const maximum = Math.max(0, rows.length - 1)
    const next = Math.max(0, Math.min(maximum, this.#scrollOffset + lines))
    if (next === this.#scrollOffset) return false
    this.#scrollOffset = next
    if (next === 0) {
      this.#followTail = true
      this.#unseenRows = 0
      this.#evictedWhileDetached = 0
      this.#focusedRowId = undefined
    } else {
      this.#followTail = false
      this.#focusedRowId = rows[Math.max(0, rows.length - next - 1)]?.id
    }
    this.#publish()
    return true
  }

  scrollPage(direction: 'down' | 'up', pageRows: number): boolean {
    this.#assertActive()
    const amount = positiveLimit(pageRows, 1, 'pageRows')
    return this.scrollLines(direction === 'up' ? amount : -amount)
  }

  toStart(): boolean {
    this.#assertActive()
    const rows = this.#store.getSnapshot().rows
    if (rows.length === 0) return false
    const next = rows.length - 1
    if (this.#scrollOffset === next && !this.#followTail) return false
    this.#scrollOffset = next
    this.#followTail = false
    this.#focusedRowId = rows[0]?.id
    this.#publish()
    return true
  }

  toEnd(): boolean {
    this.#assertActive()
    if (this.#scrollOffset === 0 && this.#followTail && this.#focusedRowId === undefined) {
      return false
    }
    this.#scrollOffset = 0
    this.#followTail = true
    this.#unseenRows = 0
    this.#evictedWhileDetached = 0
    this.#focusedRowId = undefined
    this.#publish()
    return true
  }

  focusRow(rowId: string): boolean {
    this.#assertActive()
    if (!this.#store.getSnapshot().rows.some(row => row.id === rowId)) return false
    const before = {
      focusedRowId: this.#focusedRowId,
      followTail: this.#followTail,
      scrollOffset: this.#scrollOffset,
    }
    this.#focusRow(rowId)
    if (
      before.focusedRowId !== this.#focusedRowId
      || before.followTail !== this.#followTail
      || before.scrollOffset !== this.#scrollOffset
    ) this.#publish()
    return true
  }

  openSearch(): void {
    this.#assertActive()
    if (this.#search.open) return
    this.#search = Object.freeze({ ...this.#search, open: true })
    this.#publish()
  }

  closeSearch(): void {
    this.#assertActive()
    if (!this.#search.open) return
    this.#search = Object.freeze({ ...this.#search, open: false })
    this.#publish()
  }

  clearSearch(): void {
    this.#assertActive()
    const incomplete = this.#store.getSnapshot().droppedRows > 0
    const next = Object.freeze({ ...emptySearch(incomplete), open: this.#search.open })
    if (sameSearch(this.#search, next)) return
    this.#search = next
    this.#focusedRowId = undefined
    this.#publish()
  }

  insertSearch(value: string): 'applied' | 'limit-exceeded' | 'unchanged' {
    this.#assertActive()
    if (value === '') return 'unchanged'
    if (this.#search.query.length + value.length > this.#maxSearchQueryCodeUnits) {
      return 'limit-exceeded'
    }
    this.#setSearchQuery(this.#search.query + value)
    return 'applied'
  }

  backspaceSearch(): boolean {
    this.#assertActive()
    if (this.#search.query === '') return false
    const characters = Array.from(this.#search.query)
    characters.pop()
    this.#setSearchQuery(characters.join(''))
    return true
  }

  nextMatch(direction: 'next' | 'previous' = 'next'): boolean {
    this.#assertActive()
    if (this.#search.matchIds.length === 0) return false
    const current = this.#search.activeIndex
    const next = current === undefined
      ? (direction === 'next' ? 0 : this.#search.matchIds.length - 1)
      : direction === 'next'
        ? (current + 1) % this.#search.matchIds.length
        : (current - 1 + this.#search.matchIds.length) % this.#search.matchIds.length
    this.#search = Object.freeze({ ...this.#search, activeIndex: next })
    this.#focusRow(this.#search.matchIds[next])
    this.#publish()
    return true
  }

  toggleFocusedTool(): boolean {
    this.#assertActive()
    const rows = this.#store.getSnapshot().rows
    let row = this.#focusedRowId === undefined
      ? undefined
      : rows.find(candidate => candidate.id === this.#focusedRowId)
    row ??= [...rows].reverse().find(candidate => candidate.toolCard !== undefined)
    if (row?.toolCard === undefined || row.toolCard.lines.length === 0) return false
    this.#toggleToolOverride(row.id)
    this.#focusedRowId = row.id
    this.#publish()
    return true
  }

  toggleCompactTools(): void {
    this.#assertActive()
    this.#compactTools = !this.#compactTools
    this.#toolOverrides.clear()
    this.#toolPageOffsets.clear()
    this.#publish()
  }

  scrollFocusedTool(direction: 'down' | 'up', pageLines: number): boolean {
    this.#assertActive()
    const amount = positiveLimit(pageLines, 1, 'pageLines')
    const rows = this.#store.getSnapshot().rows
    let row = this.#focusedRowId === undefined
      ? undefined
      : rows.find(candidate => candidate.id === this.#focusedRowId)
    row ??= this.#focusedRowId === undefined
      ? [...rows].reverse().find(candidate => candidate.toolCard !== undefined)
      : undefined
    const lines = row?.toolCard?.lines
    if (row === undefined || lines === undefined || lines.length === 0 || this.#toolCollapsed(row.id)) {
      return false
    }
    const current = this.#toolPageOffsets.get(row.id) ?? 0
    const next = Math.max(0, Math.min(lines.length - 1, current + (direction === 'down' ? amount : -amount)))
    if (next === current) return false
    this.#setToolPageOffset(row.id, next)
    this.#focusedRowId = row.id
    this.#publish()
    return true
  }

  projectRows(
    rows: readonly TranscriptRow[],
    options: TranscriptRowProjectionOptions = {},
  ): readonly TranscriptRow[] {
    this.#assertActive()
    const maximum = options.maxToolDetailLines === undefined
      ? undefined
      : positiveLimit(options.maxToolDetailLines, 1, 'maxToolDetailLines')
    let changed = false
    const projected = rows.map((row) => {
      const card = row.toolCard
      if (card === undefined || card.lines.length === 0) {
        return row
      }
      const detailMaximum = maximum === undefined
        ? undefined
        : Math.max(0, maximum - (card.truncated === true ? 1 : 0))
      let lines: readonly string[]
      if (this.#toolCollapsed(row.id)) {
        lines = detailMaximum === 0
          ? []
          : [`[${String(card.lines.length)} detail lines folded]`]
      } else if (detailMaximum !== undefined && card.lines.length > detailMaximum) {
        lines = detailMaximum === 0 ? [] : this.#toolPage(card.lines, row.id, detailMaximum)
      } else {
        return row
      }
      changed = true
      return Object.freeze({
        ...row,
        toolCard: Object.freeze({
          ...card,
          lines: Object.freeze(lines),
        }),
      })
    })
    return changed ? Object.freeze(projected) : rows
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe()
    this.#listeners.clear()
    this.#toolOverrides.clear()
    this.#toolPageOffsets.clear()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('TranscriptViewportController is disposed')
  }

  #createSnapshot(transcript: TranscriptState): TranscriptViewportSnapshot {
    return Object.freeze({
      compactTools: this.#compactTools,
      evictedWhileDetached: this.#evictedWhileDetached,
      ...(this.#focusedRowId === undefined ? {} : { focusedRowId: this.#focusedRowId }),
      followTail: this.#followTail,
      historyTruncated: transcript.droppedRows > 0,
      revision: this.#revision,
      scrollOffset: this.#scrollOffset,
      search: this.#search,
      unseenRows: this.#unseenRows,
    })
  }

  #focusRow(rowId: string | undefined): void {
    if (rowId === undefined) return
    const rows = this.#store.getSnapshot().rows
    const index = rows.findIndex(row => row.id === rowId)
    if (index === -1) return
    this.#focusedRowId = rowId
    this.#scrollOffset = Math.max(0, rows.length - index - 1)
    this.#followTail = false
  }

  #onTranscriptChanged = (): void => {
    if (this.#disposed) return
    const transcript = this.#store.getSnapshot()
    const materialRows = transcript.droppedRows + transcript.rows.length
    const added = Math.max(0, materialRows - this.#lastMaterialRows)
    const evicted = Math.max(0, transcript.droppedRows - this.#lastDroppedRows)
    this.#lastMaterialRows = materialRows
    this.#lastDroppedRows = transcript.droppedRows

    if (this.#followTail) {
      this.#scrollOffset = 0
      this.#unseenRows = 0
    } else {
      this.#scrollOffset = Math.min(
        Math.max(0, transcript.rows.length - 1),
        this.#scrollOffset + added,
      )
      this.#unseenRows = saturatingAdd(this.#unseenRows, added)
      this.#evictedWhileDetached = saturatingAdd(this.#evictedWhileDetached, evicted)
      if (
        this.#focusedRowId !== undefined
        && !transcript.rows.some(row => row.id === this.#focusedRowId)
      ) {
        this.#focusedRowId = transcript.rows[Math.max(0, transcript.rows.length - this.#scrollOffset - 1)]?.id
      }
    }
    this.#removeStaleToolOverrides(transcript.rows)
    this.#refreshSearch(transcript)
    this.#publish(transcript)
  }

  #publish(transcript = this.#store.getSnapshot()): void {
    this.#revision += 1
    this.#snapshot = this.#createSnapshot(transcript)
    for (const listener of this.#listeners) listener()
  }

  #refreshSearch(transcript: TranscriptState): void {
    const query = this.#search.query.toLowerCase()
    const newestMatches: string[] = []
    let totalMatches = 0
    let indexedCodeUnits = 0
    let indexIncomplete = false
    if (query !== '') {
      for (let index = transcript.rows.length - 1; index >= 0; index -= 1) {
        const row = transcript.rows[index]
        if (row === undefined) continue
        let text = this.#searchTextCache.get(row)
        if (text === undefined) {
          text = rowSearchText(row)
          this.#searchTextCache.set(row, text)
        }
        const remaining = this.#maxSearchTextCodeUnits - indexedCodeUnits
        if (remaining <= 0) {
          indexIncomplete = true
          break
        }
        const indexed = text.length <= remaining ? text : text.slice(0, remaining)
        indexedCodeUnits += indexed.length
        if (
          indexed.length < text.length
          || (index > 0 && indexedCodeUnits >= this.#maxSearchTextCodeUnits)
        ) {
          indexIncomplete = true
        }
        if (!indexed.includes(query)) continue
        totalMatches += 1
        if (newestMatches.length < this.#maxSearchMatches) newestMatches.push(row.id)
      }
    }
    const matches = newestMatches.reverse()
    const previousActiveId = this.#search.activeIndex === undefined
      ? undefined
      : this.#search.matchIds[this.#search.activeIndex]
    let activeIndex = previousActiveId === undefined
      ? undefined
      : matches.indexOf(previousActiveId)
    if (activeIndex === -1) activeIndex = matches.length === 0 ? undefined : 0
    this.#search = Object.freeze({
      ...(activeIndex === undefined ? {} : { activeIndex }),
      incomplete: transcript.droppedRows > 0 || indexIncomplete,
      matchIds: Object.freeze(matches),
      open: this.#search.open,
      query: this.#search.query,
      totalMatches,
      truncated: totalMatches > matches.length,
    })
    if (activeIndex !== undefined) this.#focusRow(matches[activeIndex])
  }

  #removeStaleToolOverrides(rows: readonly TranscriptRow[]): void {
    if (this.#toolOverrides.size === 0 && this.#toolPageOffsets.size === 0) return
    const ids = new Set(rows.map(row => row.id))
    for (const id of this.#toolOverrides) {
      if (!ids.has(id)) this.#toolOverrides.delete(id)
    }
    for (const id of this.#toolPageOffsets.keys()) {
      if (!ids.has(id)) this.#toolPageOffsets.delete(id)
    }
  }

  #setSearchQuery(query: string): void {
    this.#search = Object.freeze({ ...this.#search, query })
    this.#refreshSearch(this.#store.getSnapshot())
    if (this.#search.activeIndex === undefined && this.#search.matchIds.length > 0) {
      this.#search = Object.freeze({ ...this.#search, activeIndex: 0 })
      this.#focusRow(this.#search.matchIds[0])
    }
    if (query === '') this.#focusedRowId = undefined
    this.#publish()
  }

  #toggleToolOverride(rowId: string): void {
    if (this.#toolOverrides.delete(rowId)) return
    this.#toolOverrides.add(rowId)
    while (this.#toolOverrides.size > this.#maxToolOverrides) {
      const oldest = this.#toolOverrides.values().next().value as string | undefined
      if (oldest === undefined) break
      this.#toolOverrides.delete(oldest)
    }
  }

  #setToolPageOffset(rowId: string, offset: number): void {
    this.#toolPageOffsets.delete(rowId)
    this.#toolPageOffsets.set(rowId, offset)
    while (this.#toolPageOffsets.size > this.#maxToolOverrides) {
      const oldest = this.#toolPageOffsets.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#toolPageOffsets.delete(oldest)
    }
  }

  #toolPage(lines: readonly string[], rowId: string, maximum: number): readonly string[] {
    if (maximum === 1) {
      return [`[${String(lines.length)} detail lines · Alt+PageUp/Down to browse]`]
    }
    const configuredOffset = this.#toolPageOffsets.get(rowId) ?? 0
    const offset = Math.max(0, Math.min(lines.length - 1, configuredOffset))
    const topMarker = offset > 0
    let contentCapacity = maximum - (topMarker ? 1 : 0)
    let end = Math.min(lines.length, offset + contentCapacity)
    const bottomMarker = end < lines.length
    if (bottomMarker) {
      contentCapacity = Math.max(0, contentCapacity - 1)
      end = Math.min(lines.length, offset + contentCapacity)
    }
    return [
      ...(topMarker ? [`[${String(offset)} earlier detail lines · Alt+PageUp]`] : []),
      ...lines.slice(offset, end),
      ...(end < lines.length
        ? [`[${String(lines.length - end)} later detail lines · Alt+PageDown]`]
        : []),
    ]
  }

  #toolCollapsed(rowId: string): boolean {
    return this.#compactTools
      ? !this.#toolOverrides.has(rowId)
      : this.#toolOverrides.has(rowId)
  }
}
