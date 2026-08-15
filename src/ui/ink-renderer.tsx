import { useSyncExternalStore } from 'react'
import { Box, Text, renderToString } from 'ink'

import type { TranscriptStore } from '../model/transcript-controller'
import type { ScreenModel, TranscriptRowKind } from '../model/view-model'
import { createScreenModel } from '../model/view-model'

const ROW_PREFIX: Record<TranscriptRowKind, string> = {
  assistant: 'A',
  system: '!',
  tool: 'T',
  user: 'U',
}

interface FrameProps {
  readonly columns: number
  readonly model: ScreenModel
}

const ROW_STATUS: Record<NonNullable<ScreenModel['rows'][number]['status']>, string> = {
  complete: '',
  error: ' [error]',
  pending: ' [pending]',
  streaming: ' [streaming]',
}

export function Frame({ columns, model }: FrameProps) {
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>
        dsh-tui · {model.sessionId} · {model.status}
      </Text>
      <Text dimColor>
        {model.visibleRange === undefined
          ? 'transcript empty'
          : `transcript ${model.visibleRange.start}–${model.visibleRange.end} of ${model.totalRows}`}
      </Text>
      <Box flexDirection="column">
        {model.rows.map((row) => (
          <Text key={row.id} wrap="truncate-end">
            {ROW_PREFIX[row.kind]} {row.content}
            {row.status === undefined ? '' : ROW_STATUS[row.status]}
          </Text>
        ))}
      </Box>
      {model.modal === undefined ? null : (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold>
            {model.modal.title} · agent {model.modal.agentLabel}
          </Text>
          <Text wrap="truncate-end">{model.modal.message}</Text>
        </Box>
      )}
    </Box>
  )
}

interface TranscriptFrameProps {
  readonly columns: number
  readonly controller: TranscriptStore
  readonly sessionId: string
  readonly status: ScreenModel['status']
  readonly terminalRows: number
}

export function TranscriptFrame({
  columns,
  controller,
  sessionId,
  status,
  terminalRows,
}: TranscriptFrameProps) {
  const transcript = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  return (
    <Frame
      columns={columns}
      model={createScreenModel(transcript.rows, { sessionId, status, terminalRows })}
    />
  )
}

export function renderInkFrame(model: ScreenModel, columns: number): string {
  return renderToString(<Frame columns={columns} model={model} />, { columns })
}
