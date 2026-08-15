export type TranscriptRowKind = 'assistant' | 'system' | 'tool' | 'user'

export interface TranscriptRow {
  readonly content: string
  readonly id: string
  readonly kind: TranscriptRowKind
}

export interface InteractionModal {
  readonly agentLabel: string
  readonly message: string
  readonly title: string
}

export interface ScreenModel {
  readonly modal?: InteractionModal
  readonly rows: readonly TranscriptRow[]
  readonly sessionId: string
  readonly status: 'busy' | 'idle'
  readonly totalRows: number
  readonly visibleRange?: {
    readonly end: number
    readonly start: number
  }
}

export interface WindowOptions {
  readonly modalRows?: number
  readonly scrollOffset?: number
  readonly sessionId: string
  readonly status: 'busy' | 'idle'
  readonly terminalRows: number
}

const CHROME_ROWS = 3

export function createScreenModel(
  rows: readonly TranscriptRow[],
  options: WindowOptions,
  modal?: InteractionModal,
): ScreenModel {
  const scrollOffset = Math.max(0, options.scrollOffset ?? 0)
  const modalRows = modal === undefined ? 0 : Math.max(0, options.modalRows ?? 4)
  const visibleCount = Math.max(1, options.terminalRows - CHROME_ROWS - modalRows)
  const end = Math.max(0, rows.length - scrollOffset)
  const start = Math.max(0, end - visibleCount)

  return {
    ...(modal === undefined ? {} : { modal }),
    rows: rows.slice(start, end),
    sessionId: options.sessionId,
    status: options.status,
    totalRows: rows.length,
    ...(end === start ? {} : { visibleRange: { end, start: start + 1 } }),
  }
}
