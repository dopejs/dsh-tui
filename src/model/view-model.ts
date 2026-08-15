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
  readonly modelLabel?: string
  readonly modal?: InteractionModal
  readonly rows: readonly TranscriptRow[]
  readonly sessionId: string
  readonly status: 'busy' | 'idle'
  readonly totalRows: number
  readonly workspace?: string
  readonly visibleRange?: {
    readonly end: number
    readonly start: number
  }
}

export interface WindowOptions {
  readonly modelLabel?: string
  readonly modalRows?: number
  readonly scrollOffset?: number
  readonly sessionId: string
  readonly status: 'busy' | 'idle'
  readonly terminalRows: number
  readonly workspace?: string
}

const CHROME_ROWS = 3

export function createScreenModel(
  rows: readonly TranscriptRow[],
  options: WindowOptions,
  modal?: InteractionModal,
): ScreenModel {
  const scrollOffset = Math.max(0, options.scrollOffset ?? 0)
  const modalRows = modal === undefined ? 0 : Math.max(0, options.modalRows ?? 4)
  const metadataRows = options.modelLabel === undefined && options.workspace === undefined ? 0 : 1
  const visibleCount = Math.max(
    1,
    options.terminalRows - CHROME_ROWS - metadataRows - modalRows,
  )
  const end = Math.max(0, rows.length - scrollOffset)
  const start = Math.max(0, end - visibleCount)

  return {
    ...(options.modelLabel === undefined ? {} : { modelLabel: options.modelLabel }),
    ...(modal === undefined ? {} : { modal }),
    rows: rows.slice(start, end),
    sessionId: options.sessionId,
    status: options.status,
    totalRows: rows.length,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(end === start ? {} : { visibleRange: { end, start: start + 1 } }),
  }
}
