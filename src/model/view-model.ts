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
  readonly droppedRows?: number
  readonly focusedRowId?: string
  readonly modelLabel?: string
  readonly modal?: InteractionModal
  readonly rows: readonly TranscriptRow[]
  readonly sessionId: string
  readonly status: 'busy' | 'idle'
  readonly totalRows: number
  readonly unseenRows?: number
  readonly workspace?: string
  readonly visibleRange?: {
    readonly end: number
    readonly start: number
  }
}

export interface WindowOptions {
  readonly droppedRows?: number
  readonly focusedRowId?: string
  readonly modelLabel?: string
  readonly modalRows?: number
  readonly scrollOffset?: number
  readonly sessionId: string
  readonly status: 'busy' | 'idle'
  readonly terminalRows: number
  readonly unseenRows?: number
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
  const metadataRows = options.modelLabel === undefined && options.workspace === undefined ? 0 : 1
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
    ...(modal === undefined ? {} : { modal }),
    rows: rows.slice(start, end),
    sessionId: options.sessionId,
    status: options.status,
    totalRows: rows.length,
    ...(options.unseenRows === undefined || options.unseenRows === 0
      ? {}
      : { unseenRows: options.unseenRows }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(end === start ? {} : { visibleRange: { end, start: start + 1 } }),
  }
}
