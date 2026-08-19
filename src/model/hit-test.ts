/**
 * What is under a click.
 *
 * A terminal reports a cell, not an element. Turning one into the other means
 * repeating the arithmetic the renderer does when it lays rows out, which is
 * why the row height lives in one place and is used by both: a hit test that
 * measured rows differently from the renderer would be right only until the
 * first row that is not one line tall.
 */
import type { TranscriptRow } from './view-model'
import { transcriptRowHeight } from './view-model'

export interface TranscriptHit {
  /**
   * True when the click landed on the row's reasoning, folded or drawn in
   * full. Expanded, there is no fold affordance left to aim at, so the
   * reasoning itself is what collapses it.
   */
  readonly onReasoningFold: boolean
  readonly rowId: string
}

export interface TranscriptHitOptions {
  /** Screen line the transcript's first row starts on. */
  readonly firstLine: number
  /** Rows in the order they are drawn. */
  readonly rows: readonly TranscriptRow[]
  /** Reasoning is drawn in full for these, so the fold line is absent. */
  readonly expandedRowIds?: ReadonlySet<string>
}

/**
 * The row drawn at a screen line, and whether that line is its fold affordance.
 *
 * Returns nothing for a line no row occupies, rather than the nearest row: a
 * click on empty space is not a click on the thing above it.
 */
export function hitTestTranscript(
  line: number,
  options: TranscriptHitOptions,
): TranscriptHit | undefined {
  let cursor = options.firstLine
  for (const [index, row] of options.rows.entries()) {
    const expanded = options.expandedRowIds?.has(row.id) === true
    const separator = index === 0 ? 0 : 1
    const reasoningLines = row.reasoning === undefined
      ? 0
      : expanded
        ? row.reasoning.split('\n').length
        : 1
    const height = transcriptRowHeight(row, index === 0)
      // The shared height counts one line for folded reasoning; an expanded
      // row draws every line of it instead.
      + (row.reasoning === undefined || !expanded ? 0 : reasoningLines - 1)
    const start = cursor
    cursor += height
    if (line < start || line >= cursor) continue

    // Reasoning is drawn above the row's own line, after the separator.
    const reasoningStart = start + separator
    return Object.freeze({
      onReasoningFold: row.reasoning !== undefined
        && line >= reasoningStart
        && line < reasoningStart + reasoningLines,
      rowId: row.id,
    })
  }
  return undefined
}
