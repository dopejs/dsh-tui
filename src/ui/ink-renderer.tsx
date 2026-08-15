import { Box, Text, renderToString } from 'ink'

import type { ScreenModel, TranscriptRowKind } from '../model/view-model.js'

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

function Frame({ columns, model }: FrameProps) {
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

export function renderInkFrame(model: ScreenModel, columns: number): string {
  return renderToString(<Frame columns={columns} model={model} />, { columns })
}
