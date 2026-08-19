export const DEFAULT_EDITOR_HISTORY_LIMIT = 200
export const DEFAULT_EDITOR_HISTORY_CODE_UNIT_LIMIT = 1_000_000
export const DEFAULT_EDITOR_UNDO_LIMIT = 200
export const DEFAULT_EDITOR_UNDO_CODE_UNIT_LIMIT = 2_000_000
export const DEFAULT_EDITOR_TEXT_LIMIT = 100_000

export type EditorMove =
  | 'document-end'
  | 'document-start'
  | 'down'
  | 'left'
  | 'line-end'
  | 'line-start'
  | 'right'
  | 'up'
  | 'word-left'
  | 'word-right'

export type EditorEditResult = 'applied' | 'limit-exceeded' | 'unchanged'

export interface EditorSnapshot {
  readonly anchor?: number
  readonly canRedo: boolean
  readonly canUndo: boolean
  readonly cursor: number
  readonly historyIndex?: number
  readonly historySize: number
  readonly revision: number
  readonly text: string
}

export interface EditorSubmissionDraft {
  readonly revision: number
  readonly text: string
}

export interface EditorHistoryMatch {
  readonly index: number
  readonly text: string
}

export interface EditorControllerOptions {
  readonly history?: readonly string[]
  readonly historyCodeUnitLimit?: number
  readonly historyLimit?: number
  readonly initialText?: string
  readonly textLimit?: number
  readonly undoLimit?: number
  readonly undoCodeUnitLimit?: number
}

interface EditableState {
  readonly anchor?: number
  readonly cursor: number
  readonly text: string
}

type Listener = () => void

const EXTENDING_CODE_POINT = /^(?:\p{M}|\p{Emoji_Modifier}|\uFE0E|\uFE0F)$/u
const WORD_CODE_POINT = /^[\p{L}\p{N}_]$/u

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function previousCodePointOffset(text: string, offset: number): number {
  if (offset <= 0) return 0
  const trailing = text.charCodeAt(offset - 1)
  if (trailing >= 0xDC00 && trailing <= 0xDFFF && offset >= 2) {
    const leading = text.charCodeAt(offset - 2)
    if (leading >= 0xD800 && leading <= 0xDBFF) return offset - 2
  }
  return offset - 1
}

function nextCodePointOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length
  const leading = text.charCodeAt(offset)
  if (leading >= 0xD800 && leading <= 0xDBFF && offset + 1 < text.length) {
    const trailing = text.charCodeAt(offset + 1)
    if (trailing >= 0xDC00 && trailing <= 0xDFFF) return offset + 2
  }
  return offset + 1
}

function codePointAt(text: string, offset: number): string {
  return text.slice(offset, nextCodePointOffset(text, offset))
}

function previousCharacterOffset(text: string, offset: number): number {
  let start = previousCodePointOffset(text, offset)
  while (start > 0 && EXTENDING_CODE_POINT.test(codePointAt(text, start))) {
    start = previousCodePointOffset(text, start)
  }

  // Keep common emoji ZWJ sequences together. The editor's storage offset is
  // UTF-16, but every user movement remains on a complete scalar sequence.
  while (start > 0) {
    const joiner = previousCodePointOffset(text, start)
    if (codePointAt(text, joiner) !== '\u200D') break
    start = previousCodePointOffset(text, joiner)
    while (start > 0 && EXTENDING_CODE_POINT.test(codePointAt(text, start))) {
      start = previousCodePointOffset(text, start)
    }
  }
  return start
}

function nextCharacterOffset(text: string, offset: number): number {
  let end = nextCodePointOffset(text, offset)
  while (end < text.length && EXTENDING_CODE_POINT.test(codePointAt(text, end))) {
    end = nextCodePointOffset(text, end)
  }
  while (end < text.length && codePointAt(text, end) === '\u200D') {
    end = nextCodePointOffset(text, end)
    if (end < text.length) end = nextCodePointOffset(text, end)
    while (end < text.length && EXTENDING_CODE_POINT.test(codePointAt(text, end))) {
      end = nextCodePointOffset(text, end)
    }
  }
  return end
}

function lineStart(text: string, cursor: number): number {
  return cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1
}

function lineEnd(text: string, cursor: number): number {
  const end = text.indexOf('\n', cursor)
  return end === -1 ? text.length : end
}

function characterColumn(text: string, start: number, cursor: number): number {
  let column = 0
  for (let offset = start; offset < cursor; column += 1) {
    offset = nextCharacterOffset(text, offset)
  }
  return column
}

function offsetAtColumn(text: string, start: number, end: number, column: number): number {
  let offset = start
  for (let current = 0; current < column && offset < end; current += 1) {
    offset = nextCharacterOffset(text, offset)
  }
  return offset
}

function selectedRange(state: EditableState): readonly [number, number] | undefined {
  if (state.anchor === undefined || state.anchor === state.cursor) return undefined
  return state.anchor < state.cursor
    ? [state.anchor, state.cursor]
    : [state.cursor, state.anchor]
}

function sameEditableState(left: EditableState, right: EditableState): boolean {
  return left.text === right.text
    && left.cursor === right.cursor
    && left.anchor === right.anchor
}

function snapshotFor(
  state: EditableState,
  revision: number,
  undoSize: number,
  redoSize: number,
  historySize: number,
  historyIndex: number | undefined,
): EditorSnapshot {
  return {
    ...(state.anchor === undefined ? {} : { anchor: state.anchor }),
    canRedo: redoSize > 0,
    canUndo: undoSize > 0,
    cursor: state.cursor,
    ...(historyIndex === undefined ? {} : { historyIndex }),
    historySize,
    revision,
    text: state.text,
  }
}

export class EditorController {
  readonly #historyCodeUnitLimit: number
  readonly #historyLimit: number
  readonly #listeners = new Set<Listener>()
  readonly #textLimit: number
  readonly #undoLimit: number
  readonly #undoCodeUnitLimit: number
  readonly #history: string[]
  readonly #undo: EditableState[] = []
  readonly #redo: EditableState[] = []
  #disposed = false
  #historyDraft: string | undefined
  #historyIndex: number | undefined
  #preferredColumn: number | undefined
  #revision = 0
  #state: EditableState
  #snapshot: EditorSnapshot
  #textRevision = 0
  #yank = ''

  constructor(options: EditorControllerOptions = {}) {
    const historyCodeUnitLimit = options.historyCodeUnitLimit
      ?? DEFAULT_EDITOR_HISTORY_CODE_UNIT_LIMIT
    const historyLimit = options.historyLimit ?? DEFAULT_EDITOR_HISTORY_LIMIT
    const textLimit = options.textLimit ?? DEFAULT_EDITOR_TEXT_LIMIT
    const undoLimit = options.undoLimit ?? DEFAULT_EDITOR_UNDO_LIMIT
    const undoCodeUnitLimit = options.undoCodeUnitLimit
      ?? DEFAULT_EDITOR_UNDO_CODE_UNIT_LIMIT
    assertPositiveInteger(historyCodeUnitLimit, 'historyCodeUnitLimit')
    assertPositiveInteger(historyLimit, 'historyLimit')
    assertPositiveInteger(textLimit, 'textLimit')
    assertPositiveInteger(undoLimit, 'undoLimit')
    assertPositiveInteger(undoCodeUnitLimit, 'undoCodeUnitLimit')
    const initialText = options.initialText ?? ''
    if (initialText.length > textLimit) {
      throw new RangeError(`initialText exceeds the ${String(textLimit)} code-unit limit`)
    }
    this.#historyCodeUnitLimit = historyCodeUnitLimit
    this.#historyLimit = historyLimit
    this.#textLimit = textLimit
    this.#undoLimit = undoLimit
    this.#undoCodeUnitLimit = undoCodeUnitLimit
    this.#history = (options.history ?? [])
      .filter(entry => entry.trim() !== '' && entry.length <= textLimit)
      .slice(-historyLimit)
    this.#trimHistory()
    this.#state = { cursor: initialText.length, text: initialText }
    this.#snapshot = snapshotFor(this.#state, 0, 0, 0, this.#history.length, undefined)
  }

  get textLimit(): number {
    return this.#textLimit
  }

  getSnapshot = (): EditorSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  captureSubmission(): EditorSubmissionDraft {
    this.#assertActive()
    return { revision: this.#textRevision, text: this.#state.text }
  }

  acceptSubmission(draft: EditorSubmissionDraft): boolean {
    this.#assertActive()
    const historyChanged = draft.text.trim() !== '' && this.#recordHistory(draft.text)
    if (draft.revision !== this.#textRevision || draft.text !== this.#state.text) {
      if (historyChanged) this.#publish()
      return false
    }
    this.#state = { cursor: 0, text: '' }
    this.#textRevision += 1
    this.#undo.length = 0
    this.#redo.length = 0
    this.#historyIndex = undefined
    this.#historyDraft = undefined
    this.#preferredColumn = undefined
    this.#publish()
    return true
  }

  insert(value: string): EditorEditResult {
    this.#assertActive()
    if (value === '') return 'unchanged'
    const range = selectedRange(this.#state)
    const removedLength = range === undefined ? 0 : range[1] - range[0]
    if (this.#state.text.length - removedLength + value.length > this.#textLimit) {
      return 'limit-exceeded'
    }
    const start = range?.[0] ?? this.#state.cursor
    const end = range?.[1] ?? this.#state.cursor
    const text = this.#state.text.slice(0, start) + value + this.#state.text.slice(end)
    this.#applyEdit({ cursor: start + value.length, text })
    return 'applied'
  }

  replaceRange(start: number, end: number, value: string): EditorEditResult {
    this.#assertActive()
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end > this.#state.text.length
    ) {
      throw new RangeError('replacement range must be within the editor text')
    }
    const boundary = (offset: number): boolean => offset === 0
      || offset === this.#state.text.length
      || nextCharacterOffset(
        this.#state.text,
        previousCharacterOffset(this.#state.text, offset),
      ) === offset
    if (!boundary(start) || !boundary(end)) {
      throw new RangeError('replacement range must not split a Unicode character')
    }
    if (start === end && value === '') return 'unchanged'
    if (this.#state.text.length - (end - start) + value.length > this.#textLimit) {
      return 'limit-exceeded'
    }
    const text = this.#state.text.slice(0, start) + value + this.#state.text.slice(end)
    if (text === this.#state.text) return 'unchanged'
    this.#applyEdit({ cursor: start + value.length, text })
    return 'applied'
  }

  backspace(): EditorEditResult {
    this.#assertActive()
    const range = selectedRange(this.#state)
    if (range !== undefined) return this.#deleteRange(range[0], range[1])
    if (this.#state.cursor === 0) return 'unchanged'
    return this.#deleteRange(
      previousCharacterOffset(this.#state.text, this.#state.cursor),
      this.#state.cursor,
    )
  }

  deleteForward(): EditorEditResult {
    this.#assertActive()
    const range = selectedRange(this.#state)
    if (range !== undefined) return this.#deleteRange(range[0], range[1])
    if (this.#state.cursor === this.#state.text.length) return 'unchanged'
    return this.#deleteRange(
      this.#state.cursor,
      nextCharacterOffset(this.#state.text, this.#state.cursor),
    )
  }

  deleteWordBackward(): EditorEditResult {
    this.#assertActive()
    const range = selectedRange(this.#state)
    if (range !== undefined) return this.#deleteRange(range[0], range[1])
    const start = this.#wordLeft(this.#state.cursor)
    if (start === this.#state.cursor) return 'unchanged'
    this.#yank = this.#state.text.slice(start, this.#state.cursor)
    return this.#deleteRange(start, this.#state.cursor)
  }

  killToLineEnd(): EditorEditResult {
    this.#assertActive()
    const range = selectedRange(this.#state)
    if (range !== undefined) {
      this.#yank = this.#state.text.slice(range[0], range[1])
      return this.#deleteRange(range[0], range[1])
    }
    let end = lineEnd(this.#state.text, this.#state.cursor)
    if (end === this.#state.cursor && end < this.#state.text.length) end += 1
    if (end === this.#state.cursor) return 'unchanged'
    this.#yank = this.#state.text.slice(this.#state.cursor, end)
    return this.#deleteRange(this.#state.cursor, end)
  }

  yank(): EditorEditResult {
    this.#assertActive()
    return this.insert(this.#yank)
  }

  clearSelection(): boolean {
    this.#assertActive()
    if (this.#state.anchor === undefined) return false
    this.#setState({ cursor: this.#state.cursor, text: this.#state.text })
    this.#preferredColumn = undefined
    return true
  }

  selectAll(): void {
    this.#assertActive()
    if (this.#state.text === '') return
    this.#setState({ anchor: 0, cursor: this.#state.text.length, text: this.#state.text })
    this.#preferredColumn = undefined
  }

  move(movement: EditorMove, extend = false): boolean {
    this.#assertActive()
    const range = selectedRange(this.#state)
    if (!extend && range !== undefined && (movement === 'left' || movement === 'right')) {
      this.#setState({ cursor: movement === 'left' ? range[0] : range[1], text: this.#state.text })
      this.#preferredColumn = undefined
      return true
    }

    const cursor = this.#movementOffset(movement)
    const anchor = extend ? (this.#state.anchor ?? this.#state.cursor) : undefined
    if (cursor === this.#state.cursor && anchor === this.#state.anchor) return false
    this.#setState({ ...(anchor === undefined ? {} : { anchor }), cursor, text: this.#state.text })
    if (movement !== 'up' && movement !== 'down') this.#preferredColumn = undefined
    return true
  }

  /**
   * Put the caret at an exact offset, as a click does.
   *
   * Clamped rather than rejected: a click past the end of a line is a click
   * asking for the end of that line, which is what every editor does with it.
   */
  moveTo(offset: number, extend = false): boolean {
    this.#assertActive()
    if (!Number.isSafeInteger(offset)) return false
    const cursor = Math.max(0, Math.min(this.#state.text.length, offset))
    const anchor = extend ? (this.#state.anchor ?? this.#state.cursor) : undefined
    if (cursor === this.#state.cursor && anchor === this.#state.anchor) return false
    this.#setState({
      ...(anchor === undefined ? {} : { anchor }),
      cursor,
      text: this.#state.text,
    })
    this.#preferredColumn = undefined
    return true
  }

  previousHistory(): boolean {
    this.#assertActive()
    if (this.#history.length === 0) return false
    if (this.#historyIndex === undefined) {
      this.#historyDraft = this.#state.text
      this.#historyIndex = this.#history.length - 1
    } else if (this.#historyIndex > 0) {
      this.#historyIndex -= 1
    } else {
      return false
    }
    this.#setHistoryText(this.#history[this.#historyIndex] ?? '')
    return true
  }

  nextHistory(): boolean {
    this.#assertActive()
    if (this.#historyIndex === undefined) return false
    if (this.#historyIndex + 1 < this.#history.length) {
      this.#historyIndex += 1
      this.#setHistoryText(this.#history[this.#historyIndex] ?? '')
      return true
    }
    const draft = this.#historyDraft ?? ''
    this.#historyIndex = undefined
    this.#historyDraft = undefined
    this.#setHistoryText(draft)
    return true
  }

  searchHistory(query: string, beforeExclusive = this.#history.length): EditorHistoryMatch | undefined {
    this.#assertActive()
    const normalized = query.toLocaleLowerCase()
    for (let index = Math.min(beforeExclusive, this.#history.length) - 1; index >= 0; index -= 1) {
      const text = this.#history[index]
      if (text !== undefined && text.toLocaleLowerCase().includes(normalized)) {
        return { index, text }
      }
    }
    return undefined
  }

  useHistoryMatch(match: EditorHistoryMatch): boolean {
    this.#assertActive()
    if (match.index < 0 || match.index >= this.#history.length) return false
    if (this.#history[match.index] !== match.text) return false
    if (this.#historyIndex === undefined) this.#historyDraft = this.#state.text
    this.#historyIndex = match.index
    this.#setHistoryText(match.text)
    return true
  }

  undo(): boolean {
    this.#assertActive()
    const previous = this.#undo.pop()
    if (previous === undefined) return false
    this.#pushBounded(this.#redo, this.#state)
    this.#state = previous
    this.#textRevision += 1
    this.#detachHistory()
    this.#preferredColumn = undefined
    this.#publish()
    return true
  }

  redo(): boolean {
    this.#assertActive()
    const next = this.#redo.pop()
    if (next === undefined) return false
    this.#pushBounded(this.#undo, this.#state)
    this.#state = next
    this.#textRevision += 1
    this.#detachHistory()
    this.#preferredColumn = undefined
    this.#publish()
    return true
  }

  clear(): boolean {
    this.#assertActive()
    if (this.#state.text === '') return false
    this.#applyEdit({ cursor: 0, text: '' })
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#history.length = 0
    this.#undo.length = 0
    this.#redo.length = 0
    this.#historyDraft = undefined
    this.#yank = ''
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('EditorController is disposed')
  }

  #applyEdit(next: EditableState): void {
    if (sameEditableState(this.#state, next)) return
    this.#pushBounded(this.#undo, this.#state)
    this.#redo.length = 0
    this.#state = next
    this.#textRevision += 1
    this.#detachHistory()
    this.#preferredColumn = undefined
    this.#publish()
  }

  #deleteRange(start: number, end: number): EditorEditResult {
    if (start === end) return 'unchanged'
    this.#applyEdit({
      cursor: start,
      text: this.#state.text.slice(0, start) + this.#state.text.slice(end),
    })
    return 'applied'
  }

  #detachHistory(): void {
    this.#historyIndex = undefined
    this.#historyDraft = undefined
  }

  #movementOffset(movement: EditorMove): number {
    const { cursor, text } = this.#state
    switch (movement) {
      case 'document-start': return 0
      case 'document-end': return text.length
      case 'line-start': return lineStart(text, cursor)
      case 'line-end': return lineEnd(text, cursor)
      case 'left': return previousCharacterOffset(text, cursor)
      case 'right': return nextCharacterOffset(text, cursor)
      case 'word-left': return this.#wordLeft(cursor)
      case 'word-right': return this.#wordRight(cursor)
      case 'up': {
        const currentStart = lineStart(text, cursor)
        if (currentStart === 0) return cursor
        const previousEnd = currentStart - 1
        const previousStart = lineStart(text, previousEnd)
        const column = this.#preferredColumn
          ?? characterColumn(text, currentStart, cursor)
        this.#preferredColumn = column
        return offsetAtColumn(text, previousStart, previousEnd, column)
      }
      case 'down': {
        const currentStart = lineStart(text, cursor)
        const currentEnd = lineEnd(text, cursor)
        if (currentEnd === text.length) return cursor
        const nextStart = currentEnd + 1
        const nextEnd = lineEnd(text, nextStart)
        const column = this.#preferredColumn
          ?? characterColumn(text, currentStart, cursor)
        this.#preferredColumn = column
        return offsetAtColumn(text, nextStart, nextEnd, column)
      }
    }
  }

  #wordLeft(cursor: number): number {
    let offset = cursor
    while (offset > 0) {
      const previous = previousCharacterOffset(this.#state.text, offset)
      if (!/^\s$/u.test(this.#state.text.slice(previous, offset))) break
      offset = previous
    }
    if (offset === 0) return 0
    const previous = previousCharacterOffset(this.#state.text, offset)
    const word = WORD_CODE_POINT.test(this.#state.text.slice(previous, offset))
    offset = previous
    while (offset > 0) {
      const candidate = previousCharacterOffset(this.#state.text, offset)
      if (WORD_CODE_POINT.test(this.#state.text.slice(candidate, offset)) !== word) break
      offset = candidate
    }
    return offset
  }

  #wordRight(cursor: number): number {
    let offset = cursor
    while (offset < this.#state.text.length && /^\s$/u.test(codePointAt(this.#state.text, offset))) {
      offset = nextCharacterOffset(this.#state.text, offset)
    }
    if (offset === this.#state.text.length) return offset
    const word = WORD_CODE_POINT.test(codePointAt(this.#state.text, offset))
    offset = nextCharacterOffset(this.#state.text, offset)
    while (offset < this.#state.text.length) {
      const next = nextCharacterOffset(this.#state.text, offset)
      if (WORD_CODE_POINT.test(this.#state.text.slice(offset, next)) !== word) break
      offset = next
    }
    return offset
  }

  #pushBounded(target: EditableState[], value: EditableState): void {
    target.push(value)
    let codeUnits = target.reduce((total, state) => total + state.text.length, 0)
    while (
      target.length > 0
      && (target.length > this.#undoLimit || codeUnits > this.#undoCodeUnitLimit)
    ) {
      codeUnits -= target.shift()?.text.length ?? 0
    }
  }

  #publish(): void {
    this.#revision += 1
    this.#snapshot = snapshotFor(
      this.#state,
      this.#revision,
      this.#undo.length,
      this.#redo.length,
      this.#history.length,
      this.#historyIndex,
    )
    for (const listener of this.#listeners) listener()
  }

  #recordHistory(text: string): boolean {
    if (this.#history.at(-1) === text) return false
    this.#history.push(text)
    this.#trimHistory()
    return true
  }

  #trimHistory(): void {
    let codeUnits = this.#history.reduce((total, entry) => total + entry.length, 0)
    while (
      this.#history.length > 0
      && (this.#history.length > this.#historyLimit || codeUnits > this.#historyCodeUnitLimit)
    ) {
      codeUnits -= this.#history.shift()?.length ?? 0
    }
  }

  #setHistoryText(text: string): void {
    this.#state = { cursor: text.length, text }
    this.#textRevision += 1
    this.#undo.length = 0
    this.#redo.length = 0
    this.#preferredColumn = undefined
    this.#publish()
  }

  #setState(next: EditableState): void {
    if (sameEditableState(this.#state, next)) return
    this.#state = next
    this.#publish()
  }
}
