export type TranscriptRowKind = 'assistant' | 'system' | 'tool' | 'user'

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
  readonly terminalRows: number
  readonly unseenRows?: number
  readonly totalTokens?: number
  readonly workspace?: string
}

const CHROME_ROWS = 3

function transcriptRowHeight(row: TranscriptRow): number {
  return 1
    + (row.toolCard?.lines.length ?? 0)
    + (row.toolCard?.truncated === true ? 1 : 0)
}

export function createScreenModel(
  rows: readonly TranscriptRow[],
  options: WindowOptions,
  modal?: InteractionModal,
): ScreenModel {
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
    const height = transcriptRowHeight(rows[start - 1] as TranscriptRow)
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
    rows: rows.slice(start, end),
    sessionId: options.sessionId,
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
