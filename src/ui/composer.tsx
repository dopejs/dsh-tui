import { useLayoutEffect, useRef, useState } from 'react'
import { Box, Text, measureElement, useCursor, type DOMElement } from 'ink'
import stringWidth from 'string-width'

import type { EditorSnapshot } from '../model/editor-controller'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const TOKEN_SCAN_FACTOR = 8

interface LogicalLine {
  readonly end: number
  readonly index: number
  readonly start: number
}

export interface ComposerToken {
  readonly cursor: boolean
  readonly selected: boolean
  readonly text: string
}

export interface ComposerRow {
  readonly leadingEllipsis: boolean
  readonly line: number
  readonly tokens: readonly ComposerToken[]
  readonly trailingEllipsis: boolean
}

export interface ComposerView {
  readonly cursorLine: number
  readonly hiddenBelow: number
  readonly hiddenAbove: number
  readonly rows: readonly ComposerRow[]
  readonly totalLines: number
}

function logicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = []
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      lines.push({ end: index, index: lines.length, start })
      start = index + 1
    }
  }
  return lines
}

function safeWindowStart(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset
  const code = text.charCodeAt(offset)
  return code >= 0xDC00 && code <= 0xDFFF ? offset - 1 : offset
}

interface MeasuredToken extends ComposerToken {
  readonly end: number
  readonly start: number
  readonly width: number
}

function measuredTokens(
  snapshot: EditorSnapshot,
  line: LogicalLine,
  columns: number,
): { readonly leading: boolean; readonly tokens: readonly MeasuredToken[]; readonly trailing: boolean } {
  const scan = Math.max(32, columns * TOKEN_SCAN_FACTOR)
  const rawStart = safeWindowStart(snapshot.text, Math.max(line.start, snapshot.cursor - scan))
  const rawEnd = Math.min(line.end, snapshot.cursor + scan)
  const selectionStart = snapshot.anchor === undefined
    ? undefined
    : Math.min(snapshot.anchor, snapshot.cursor)
  const selectionEnd = snapshot.anchor === undefined
    ? undefined
    : Math.max(snapshot.anchor, snapshot.cursor)
  const tokens: MeasuredToken[] = []
  const source = snapshot.text.slice(rawStart, rawEnd)
  for (const segment of graphemes.segment(source)) {
    const start = rawStart + segment.index
    const end = start + segment.segment.length
    const cursor = snapshot.cursor >= start && snapshot.cursor < end
    const measuredWidth = stringWidth(segment.segment)
    tokens.push({
      cursor,
      end,
      selected: selectionStart !== undefined
        && selectionEnd !== undefined
        && start < selectionEnd
        && end > selectionStart,
      start,
      // A zero-width mark has no cell of its own to invert, so it borrows one.
      text: cursor && measuredWidth === 0 ? ` ${segment.segment}` : segment.segment,
      width: cursor ? Math.max(1, measuredWidth) : measuredWidth,
    })
  }
  if (snapshot.cursor === line.end) {
    // A space, not a block glyph: the cursor is drawn by inverting the cell,
    // and inverting a full block paints it in the background colour, which on
    // a dark theme is an invisible cursor. The placeholder always used a space,
    // which is why the caret was visible before the first keystroke and gone
    // after it.
    tokens.push({
      cursor: true,
      end: line.end,
      selected: false,
      start: line.end,
      text: ' ',
      width: 1,
    })
  }
  return {
    leading: rawStart > line.start,
    tokens,
    trailing: rawEnd < line.end,
  }
}

function cropTokens(
  measured: ReturnType<typeof measuredTokens>,
  columns: number,
): Omit<ComposerRow, 'line'> {
  const width = Math.max(1, columns)
  const tokens = measured.tokens
  let cursorIndex = tokens.findIndex(token => token.cursor)
  if (cursorIndex === -1) cursorIndex = 0
  const cursorWidth = tokens[cursorIndex]?.width ?? 1
  const hiddenBeforeCursor = measured.leading || cursorIndex > 0
  const hiddenAfterCursor = measured.trailing || cursorIndex + 1 < tokens.length
  const markerBudget = Number(hiddenBeforeCursor) + Number(hiddenAfterCursor)
  const tokenBudget = Math.max(cursorWidth, width - markerBudget)
  let start = cursorIndex
  let end = cursorIndex + 1
  let used = cursorWidth
  const leftTarget = hiddenAfterCursor
    ? Math.floor(Math.max(0, tokenBudget - cursorWidth) / 2)
    : Math.max(0, tokenBudget - cursorWidth)
  let leftUsed = 0
  while (start > 0 && leftUsed < leftTarget) {
    const candidate = tokens[start - 1]
    if (candidate === undefined || used + candidate.width > tokenBudget) break
    used += candidate.width
    leftUsed += candidate.width
    start -= 1
  }
  while (end < tokens.length && used < tokenBudget) {
    const candidate = tokens[end]
    if (candidate === undefined || used + candidate.width > tokenBudget) break
    used += candidate.width
    end += 1
  }
  while (start > 0 && used < tokenBudget) {
    const candidate = tokens[start - 1]
    if (candidate === undefined || used + candidate.width > tokenBudget) break
    used += candidate.width
    start -= 1
  }

  const hiddenLeading = measured.leading || start > 0
  const hiddenTrailing = measured.trailing || end < tokens.length
  let remainingMarkerCells = Math.max(0, width - used)
  const leadingEllipsis = hiddenLeading && remainingMarkerCells > 0
  if (leadingEllipsis) remainingMarkerCells -= 1
  const trailingEllipsis = hiddenTrailing && remainingMarkerCells > 0
  return {
    leadingEllipsis,
    tokens: tokens.slice(start, end).map(({ cursor, selected, text }) => ({ cursor, selected, text })),
    trailingEllipsis,
  }
}

export function createComposerView(
  snapshot: EditorSnapshot,
  columns: number,
  maxRows: number,
): ComposerView {
  if (!Number.isSafeInteger(columns) || columns < 1) throw new RangeError('columns must be positive')
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new RangeError('maxRows must be positive')
  const lines = logicalLines(snapshot.text)
  const cursorLine = lines.findIndex(line => snapshot.cursor >= line.start && snapshot.cursor <= line.end)
  const activeLine = Math.max(0, cursorLine)
  const start = Math.min(
    Math.max(0, activeLine - Math.floor(maxRows / 2)),
    Math.max(0, lines.length - maxRows),
  )
  const visible = lines.slice(start, start + maxRows)
  return {
    cursorLine: activeLine,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, lines.length - start - visible.length),
    rows: visible.map(line => ({
      ...cropTokens(measuredTokens(snapshot, line, columns), columns),
      line: line.index,
    })),
    totalLines: lines.length,
  }
}

/** Cells the `› ` / `│ ` row prefix occupies, ahead of any content. */
const PROMPT_CELLS = 2

/**
 * Rows added when placing the terminal cursor. None are needed.
 *
 * Ink moves the cursor up from what it believes is the line after its output,
 * and that belief holds because every frame now ends with a blank line. This
 * was a calibrated constant before that -- one value for a full redraw, a
 * different one for a cursor-only update, because those paths disagree about
 * where the bottom is. Kept as an escape hatch, and it should stay at zero.
 */
/**
 * Whether the terminal cursor is moved to the caret at all.
 *
 * Moving it is what lets an input method compose inside the composer. It also
 * makes Ink take its cursor-only redraw path, whose arithmetic disagrees with
 * the full-redraw path about where the bottom of the output is -- the same
 * disagreement that made a fixed row offset measure 1 in one state and 2 in
 * another.
 *
 * A screen fusing rows together was reported that this cannot reproduce
 * against an emulator, which has now disagreed with a real terminal three
 * times. `DSH_TUI_CURSOR=off` turns it back into the behaviour before any of
 * this, which is the one experiment that tells the two apart.
 */
export const CURSOR_FOLLOWS_CARET = process.env.DSH_TUI_CURSOR !== 'off'

const CURSOR_ROW_OFFSET = (() => {
  const configured = Number(process.env.DSH_TUI_CURSOR_ROW_OFFSET)
  return Number.isSafeInteger(configured) ? configured : 0
})()

/**
 * Cells between the start of a row's content and the caret.
 *
 * Measured in terminal cells rather than code units, because a CJK character
 * occupies two: counting characters would put the cursor -- and with it an
 * input method's composing text -- to the left of where the caret is drawn,
 * by one cell for every wide character already typed.
 */
function caretCellOffset(row: ComposerRow | undefined): number {
  if (row === undefined) return 0
  let cells = row.leadingEllipsis ? 1 : 0
  for (const token of row.tokens) {
    if (token.cursor) break
    cells += stringWidth(token.text)
  }
  return cells
}

interface ComposerProps {
  readonly columns: number
  readonly maxRows: number
  /** Shown only while the draft is empty; it is a hint, never real content. */
  readonly placeholder?: string
  /** Drop box drawing for screen readers. */
  readonly screenReader?: boolean
  readonly snapshot: EditorSnapshot
}

export function Composer({
  columns,
  maxRows,
  placeholder,
  screenReader = false,
  snapshot,
}: ComposerProps) {
  // Two cells for the row prefix, plus four for the frame's border and padding
  // when it is drawn. Getting this wrong crops long lines early, which the
  // cell-width test catches but a snapshot update would silently accept.
  const framePadding = screenReader ? 0 : 4
  const contentColumns = Math.max(1, columns - 2 - framePadding)
  const view = createComposerView(snapshot, contentColumns, maxRows)
  // A hint is drawn only on a genuinely empty draft, so it can never be
  // mistaken for text that would be sent.
  const showPlaceholder = placeholder !== undefined && snapshot.text === ''
  const frame = screenReader
    ? {}
    : { borderColor: 'gray' as const, borderStyle: 'round' as const, paddingX: 1 }

  /*
   * The terminal's own cursor is moved to the caret.
   *
   * The caret drawn here is an inverted cell, which a person can see and an
   * input method cannot: a composing character is drawn by the terminal at the
   * hardware cursor. Left parked wherever Ink last wrote, that put half-typed
   * pinyin outside the composer entirely, on whatever line happened to be
   * below it.
   *
   * Measured after layout rather than during it -- `measureElement` answers
   * with zeros while the tree is still being laid out.
   */
  const box = useRef<DOMElement | null>(null)
  const { setCursorPosition } = useCursor()
  /*
   * Ink writes the cursor while flushing a render, and setting a position does
   * not itself cause one. Left alone the last move is never flushed, so the
   * cursor stays wherever the previous keystroke put it -- which is where an
   * input method would draw the character being composed.
   *
   * One extra frame is forced when the position actually changes. It settles
   * immediately: the next pass computes the same position and asks for
   * nothing, so this cannot spin.
   */
  const applied = useRef<string>('')
  const [, requestFlush] = useState(0)
  const caretRow = showPlaceholder
    ? 0
    : Math.max(0, view.rows.findIndex(row => row.line === view.cursorLine))
  const caretColumn = showPlaceholder
    ? 0
    : caretCellOffset(view.rows.find(row => row.line === view.cursorLine))

  // A layout effect, not a passive one: Ink writes the cursor while flushing a
  // render, so a position set afterwards is only applied by the next flush --
  // leaving the cursor, and an input method's composing text, one keystroke
  // behind the caret.
  useLayoutEffect(() => {
    if (!CURSOR_FOLLOWS_CARET) return
    const node = box.current
    if (node === null) return
    const { x, y } = measureElement(node)
    const inset = screenReader ? 0 : 1
    const position = {
      // Horizontally the frame costs a border and a padding cell; vertically
      // only the border.
      x: x + inset * 2 + PROMPT_CELLS + caretColumn,
      y: y + inset + caretRow + CURSOR_ROW_OFFSET,
    }
    const key = `${String(position.x)}:${String(position.y)}`
    if (applied.current === key) return
    applied.current = key
    setCursorPosition(position)
    requestFlush(tick => tick + 1)
  }, [caretColumn, caretRow, screenReader, setCursorPosition, snapshot])

  return (
    <Box {...frame} flexDirection="column" ref={box}>
      {/*
        * The hint is drawn inside the same row layout as real text: same `› `
        * prefix, same cursor cell. Drawing it without the prefix left the
        * cursor reading as an indent rather than a caret, and the line jumped
        * sideways the moment the first character arrived.
        */}
      {showPlaceholder ? (
        <Text wrap="truncate-end">
          {'› '}
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </Text>
      ) : null}
      {showPlaceholder ? null : view.rows.map(row => (
        <Text key={row.line} wrap="truncate-end">
          {row.line === view.cursorLine ? '› ' : '│ '}
          {row.leadingEllipsis ? <Text dimColor>…</Text> : null}
          {row.tokens.map((token, index) => (
            <Text
              inverse={token.cursor || token.selected}
              key={`${String(row.line)}:${String(index)}`}
            >
              {token.text}
            </Text>
          ))}
          {row.trailingEllipsis ? <Text dimColor>…</Text> : null}
        </Text>
      ))}
      {view.hiddenAbove === 0 && view.hiddenBelow === 0 ? null : (
        <Text dimColor wrap="truncate-end">
          {view.hiddenAbove > 0 ? `↑${String(view.hiddenAbove)} ` : ''}
          {view.hiddenBelow > 0 ? `↓${String(view.hiddenBelow)}` : ''}
        </Text>
      )}
    </Box>
  )
}
