/**
 * `context` is content the host injected on the user's behalf -- AGENTS.md,
 * skill bodies, runtime reminders. It is kept apart from `system`, which is a
 * notice the user is meant to read, so the transcript can leave one out
 * without losing the other.
 */
export type TranscriptRowKind = 'assistant' | 'context' | 'system' | 'tool' | 'user'

export interface ToolCardModel {
  readonly card: 'diff' | 'generic' | 'read' | 'search' | 'terminal' | 'web'
  readonly lines: readonly string[]
  readonly title: string
  readonly truncated?: true
}

export interface TranscriptRow {
  readonly content: string
  readonly id: string
  readonly kind: TranscriptRowKind
  /** Model scratch work, kept apart from the answer it precedes. */
  readonly reasoning?: string
  /**
   * How long that scratch work ran, in milliseconds. Read from the durable
   * event times, so a resumed session reports what it reported live.
   */
  readonly reasoningMs?: number
  readonly status?: 'complete' | 'error' | 'pending' | 'streaming'
  readonly toolCard?: ToolCardModel
  readonly truncated?: true
}

export interface InteractionModal {
  readonly agentLabel: string
  readonly message: string
  readonly title: string
}

export interface ScreenModel {
  /** Pending plan, job, and subagent activity awaiting the user's attention. */
  readonly activityCount?: number
  /** Tokens consumed, paired with `contextWindow` to draw the gauge. */
  readonly contextUsed?: number
  /** What was loaded into context, e.g. MCP servers; omitted when nothing was. */
  readonly contextSources?: readonly { readonly count: number, readonly label: string }[]
  /** True before the first turn, so the welcome panel replaces an empty transcript. */
  readonly firstScreen?: boolean
  /** Live working segments; empty or absent renders no row at all. */
  readonly working?: readonly string[]
  /** Facts the welcome panel needs; absent when there is nothing to greet with. */
  readonly welcome?: {
    readonly cwd: string
    readonly headingText?: string
    readonly reasoningHiddenText?: string
    readonly tips?: readonly string[]
    readonly screenReader: boolean
    readonly theme: 'default' | 'high-contrast' | 'no-color'
    readonly version: string
  }
  readonly droppedRows?: number
  readonly focusedRowId?: string
  readonly modelLabel?: string
  readonly approvalPolicy?: string
  readonly contextWindow?: number
  readonly modal?: InteractionModal
  readonly rows: readonly TranscriptRow[]
  /**
   * Injected context is drawn only on request. It is what the model was given,
   * so it is never discarded -- but a turn that carries three reminders spends
   * three lines on content the user did not ask to read, before the answer.
   */
  readonly showContext?: true
  /** Injected rows currently withheld, so the count can say they exist. */
  readonly hiddenContextRows?: number
  readonly sessionId: string
  readonly permissionPreset?: string
  readonly status: 'busy' | 'idle'
  readonly totalRows: number
  readonly unseenRows?: number
  readonly totalTokens?: number
  readonly workspace?: string
  readonly visibleRange?: {
    readonly end: number
    readonly start: number
  }
}

export interface WindowOptions {
  readonly activityCount?: number
  readonly contextUsed?: number
  readonly contextSources?: readonly { readonly count: number, readonly label: string }[]
  readonly firstScreen?: boolean
  readonly welcome?: ScreenModel['welcome']
  readonly working?: readonly string[]
  readonly droppedRows?: number
  readonly focusedRowId?: string
  readonly modelLabel?: string
  readonly approvalPolicy?: string
  readonly contextWindow?: number
  readonly modalRows?: number
  readonly scrollOffset?: number
  readonly sessionId: string
  readonly permissionPreset?: string
  readonly status: 'busy' | 'idle'
  /** Draw injected context inline instead of withholding it. */
  readonly showContext?: boolean
  readonly terminalRows: number
  readonly unseenRows?: number
  readonly totalTokens?: number
  readonly workspace?: string
}

const CHROME_ROWS = 3

/**
 * How many screen rows one transcript row occupies.
 *
 * The blank line drawn between turns counts. Leaving it out let the window
 * hand the renderer more rows than the space could hold, and the overflow was
 * drawn straight through the composer -- a fused border and input line, and a
 * status line written over its own second half.
 */
function transcriptRowHeight(row: TranscriptRow, first: boolean): number {
  return 1
    + (first ? 0 : 1)
    + (row.reasoning === undefined ? 0 : 1)
    + (row.toolCard?.lines.length ?? 0)
    + (row.toolCard?.truncated === true ? 1 : 0)
}

export function createScreenModel(
  rows: readonly TranscriptRow[],
  options: WindowOptions,
  modal?: InteractionModal,
): ScreenModel {
  // Counted over every retained row, not the visible window: the count answers
  // "what is being withheld from this session", and a number that changed as
  // the user scrolled would answer nothing.
  const hiddenContextRows = options.showContext === true
    ? 0
    : rows.filter(row => row.kind === 'context').length
  const scrollOffset = Math.max(0, options.scrollOffset ?? 0)
  const modalRows = modal === undefined ? 0 : Math.max(0, options.modalRows ?? 4)
  const metadataRows = [
    options.modelLabel,
    options.workspace,
    options.permissionPreset,
    options.approvalPolicy,
    options.contextWindow,
    options.totalTokens,
  ].every(value => value === undefined) ? 0 : 1
  const visibleHeight = Math.max(
    1,
    options.terminalRows - CHROME_ROWS - metadataRows - modalRows,
  )
  const end = Math.max(0, rows.length - scrollOffset)
  let start = end
  let usedHeight = 0
  while (start > 0) {
    const height = transcriptRowHeight(rows[start - 1] as TranscriptRow, start === 1)
    if (usedHeight > 0 && usedHeight + height > visibleHeight) break
    start -= 1
    usedHeight += height
    if (usedHeight >= visibleHeight) break
  }

  return {
    ...(options.droppedRows === undefined || options.droppedRows === 0
      ? {}
      : { droppedRows: options.droppedRows }),
    ...(options.focusedRowId === undefined ? {} : { focusedRowId: options.focusedRowId }),
    ...(options.modelLabel === undefined ? {} : { modelLabel: options.modelLabel }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
    ...(modal === undefined ? {} : { modal }),
    ...(hiddenContextRows === 0 ? {} : { hiddenContextRows }),
    rows: rows.slice(start, end),
    sessionId: options.sessionId,
    ...(options.showContext === true ? { showContext: true as const } : {}),
    ...(options.permissionPreset === undefined ? {} : { permissionPreset: options.permissionPreset }),
    status: options.status,
    totalRows: rows.length,
    ...(options.unseenRows === undefined || options.unseenRows === 0
      ? {}
      : { unseenRows: options.unseenRows }),
    ...(options.activityCount === undefined || options.activityCount === 0
      ? {}
      : { activityCount: options.activityCount }),
    ...(options.contextUsed === undefined ? {} : { contextUsed: options.contextUsed }),
    ...(options.contextSources === undefined ? {} : { contextSources: options.contextSources }),
    ...(options.firstScreen === true ? { firstScreen: true } : {}),
    ...(options.welcome === undefined ? {} : { welcome: options.welcome }),
    ...(options.working === undefined || options.working.length === 0
      ? {}
      : { working: options.working }),
    ...(options.totalTokens === undefined ? {} : { totalTokens: options.totalTokens }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(end === start ? {} : { visibleRange: { end, start: start + 1 } }),
  }
}
