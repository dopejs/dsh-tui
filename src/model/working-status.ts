/**
 * The live working row.
 *
 * A terminal that shows nothing while a model is thinking reads as hung. This
 * derives what can honestly be said about work in flight — and says nothing
 * where the runtime reports nothing, rather than printing a zero.
 */

export interface WorkingStatusInput {
  /** Output tokens produced so far in this turn, when reported. */
  readonly outputTokens?: number
  /** Wall-clock milliseconds since the turn began. */
  readonly elapsedMs: number
  /** Reasoning effort in force, when the runtime reports one. */
  readonly reasoningEffort?: string
  /** Whether the agent is running; an idle agent has no working row. */
  readonly running: boolean
}

export interface WorkingStatus {
  /** Ready-to-render segments, already ordered by importance. */
  readonly segments: readonly string[]
}

/** `1.4s`, `12s`, `3m 05s` — precision where it helps, brevity where it does not. */
export function formatElapsed(milliseconds: number): string {
  // An impossible duration is clamped to zero and formatted the same way, so
  // the guard cannot produce a shape the normal path never emits.
  const safe = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0
  const seconds = safe / 1_000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${String(Math.floor(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes)}m ${String(remainder).padStart(2, '0')}s`
}

/**
 * Tokens per second, or undefined when it cannot be computed honestly.
 *
 * A rate over a sub-second window is noise, and a rate with no tokens is a
 * claim about throughput that has not been observed.
 */
export function tokensPerSecond(tokens: number | undefined, elapsedMs: number): number | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return undefined
  return Math.round((tokens / elapsedMs) * 1_000 * 10) / 10
}

/**
 * Build the working row.
 *
 * @returns segments, or an empty list when the agent is idle or nothing is
 *   known — the caller renders no row at all rather than an empty one.
 */
export function workingStatus(input: WorkingStatusInput): WorkingStatus {
  if (!input.running) return Object.freeze({ segments: Object.freeze([]) })
  const segments: string[] = [formatElapsed(input.elapsedMs)]
  const rate = tokensPerSecond(input.outputTokens, input.elapsedMs)
  if (rate !== undefined) segments.push(`${String(rate)} tok/s`)
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== '') {
    segments.push(input.reasoningEffort)
  }
  segments.push('^C cancel')
  return Object.freeze({ segments: Object.freeze(segments) })
}
