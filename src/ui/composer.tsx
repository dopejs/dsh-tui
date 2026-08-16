import { Box, Text } from 'ink'
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
      text: cursor && measuredWidth === 0 ? `█${segment.segment}` : segment.segment,
      width: cursor ? Math.max(1, measuredWidth) : measuredWidth,
    })
  }
  if (snapshot.cursor === line.end) {
    tokens.push({
      cursor: true,
      end: line.end,
      selected: false,
      start: line.end,
      text: '█',
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

interface ComposerProps {
  readonly columns: number
  readonly maxRows: number
  readonly snapshot: EditorSnapshot
}

export function Composer({ columns, maxRows, snapshot }: ComposerProps) {
  const contentColumns = Math.max(1, columns - 2)
  const view = createComposerView(snapshot, contentColumns, maxRows)
  return (
    <Box flexDirection="column">
      {view.rows.map(row => (
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
