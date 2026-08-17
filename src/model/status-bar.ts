/**
 * Status-bar primitives.
 *
 * These are pure so the exact glyphs and rounding are pinned by tests rather
 * than eyeballed in a terminal, and so the renderer holds no arithmetic.
 */

const FILLED = '█'
const EMPTY = '░'

export interface ContextGauge {
  /** The bar itself, exactly `width` cells wide. */
  readonly bar: string
  /** Whole percent, clamped to 0–100. */
  readonly percent: number
  /** True once the context is close enough to full to warrant attention. */
  readonly pressured: boolean
}

/**
 * Render a context-usage gauge.
 *
 * A run that has consumed its window is the single most useful thing the status
 * line can tell someone mid-session, so the bar never rounds a non-empty usage
 * down to an empty bar, and never rounds an incomplete one up to full.
 *
 * @param used - tokens consumed; negative and non-finite values read as zero.
 * @param capacity - the model's context window; zero or unknown yields no gauge.
 * @param width - bar width in cells.
 */
export function contextGauge(
  used: number,
  capacity: number | undefined,
  width = 10,
): ContextGauge | undefined {
  if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) return undefined
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new RangeError('width must be a positive safe integer')
  }
  const consumed = Number.isFinite(used) && used > 0 ? used : 0
  const ratio = Math.min(1, consumed / capacity)
  const percent = Math.min(100, Math.round(ratio * 100))

  let filled = Math.round(ratio * width)
  // Any real usage shows at least one cell; anything short of the window keeps
  // at least one cell empty. Otherwise the bar reads as 0% or 100% when it is
  // neither, which is exactly when the number matters.
  if (consumed > 0 && filled === 0) filled = 1
  if (ratio < 1 && filled === width) filled = width - 1

  return Object.freeze({
    bar: FILLED.repeat(filled) + EMPTY.repeat(width - filled),
    percent,
    pressured: ratio >= 0.8,
  })
}

/** Format a token count compactly: 1234 → `1.2k`, 1234567 → `1.2M`. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const rounded = Math.floor(value)
  if (rounded < 1_000) return String(rounded)
  if (rounded < 1_000_000) return `${(rounded / 1_000).toFixed(1)}k`
  return `${(rounded / 1_000_000).toFixed(1)}M`
}

export interface ContextSource {
  readonly count: number
  readonly label: string
}

/**
 * Summarize what was loaded into the session's context, e.g.
 * `1 CLAUDE.md · 2 MCP servers`. Sources with nothing to report are omitted
 * rather than shown as zero, so the line stays about what is actually loaded.
 */
export function describeSources(sources: readonly ContextSource[]): string | undefined {
  const present = sources.filter(source => source.count > 0)
  if (present.length === 0) return undefined
  return present
    .map(source => `${String(source.count)} ${source.label}${source.count === 1 ? '' : 's'}`)
    .join(' · ')
}
