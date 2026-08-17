/**
 * Folding for injected context rows.
 *
 * `agent.inject()` puts synthetic user-role content on the durable surface:
 * AGENTS.md, CLAUDE.md, skill bodies, file-change notices, runtime reminders.
 * The transcript must still render it — it is what the model was actually
 * given — but rendering it at full length means a session opens on a wall of
 * instructions instead of the conversation, which is what a user came for.
 *
 * So it is folded, not hidden: the first meaningful line stays visible, the
 * rest is one summary the user can expand.
 */

/** Rows shorter than this are never worth a fold affordance. */
const FOLD_THRESHOLD_LINES = 3

export interface FoldedContent {
  /** True when a fold is in effect and there is more to see. */
  readonly folded: boolean
  /** How many lines the fold is hiding; zero when nothing is hidden. */
  readonly hiddenLines: number
  /** The lines to render. */
  readonly lines: readonly string[]
}

/** The first line with something on it, so a leading blank never becomes the summary. */
function firstMeaningful(lines: readonly string[]): { text: string } {
  for (const line of lines) {
    if (line.trim() !== '') return { text: line }
  }
  return { text: lines[0] ?? '' }
}

/**
 * Fold injected content to its first meaningful line.
 *
 * @param content - the injected text, verbatim from the durable event.
 * @param expanded - when true, nothing is folded.
 * @param threshold - line count below which folding is pointless.
 */
export function foldInjectedContent(
  content: string,
  expanded = false,
  threshold = FOLD_THRESHOLD_LINES,
): FoldedContent {
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new RangeError('threshold must be a positive safe integer')
  }
  const lines = content.split('\n')
  if (expanded || lines.length <= threshold) {
    return Object.freeze({ folded: false, hiddenLines: 0, lines: Object.freeze(lines) })
  }
  const { text } = firstMeaningful(lines)
  return Object.freeze({
    folded: true,
    // Everything except the one line kept, including any blanks skipped over.
    hiddenLines: lines.length - 1,
    lines: Object.freeze([text]),
  })
}

/**
 * The label for a folded row, e.g. `+ 41 lines · ^E expand`.
 *
 * It names the key rather than only the count, because a fold the user cannot
 * discover how to open is just truncation.
 */
export function foldSummary(hiddenLines: number, expandKey = '^E'): string {
  const unit = hiddenLines === 1 ? 'line' : 'lines'
  return `+ ${String(hiddenLines)} ${unit} · ${expandKey} expand`
}
