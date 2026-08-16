import { useSyncExternalStore } from 'react'
import { Box, Text, renderToString } from 'ink'

import type { TranscriptStore } from '../model/transcript-controller'
import type { InteractionSnapshot, InteractionStore } from '../model/interaction-controller'
import type { InteractionModal, ScreenModel, TranscriptRowKind } from '../model/view-model'
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
      <Text bold wrap="truncate-end">
        dsh-tui · {model.sessionId} · {model.status}
      </Text>
      {model.modelLabel === undefined && model.workspace === undefined ? null : (
        <Text dimColor wrap="truncate-end">
          {[model.modelLabel, model.workspace].filter(Boolean).join(' · ')}
        </Text>
      )}
      <Text dimColor>
        {model.visibleRange === undefined
          ? 'transcript empty'
          : `transcript ${model.visibleRange.start}–${model.visibleRange.end} of ${model.totalRows}`}
        {model.droppedRows === undefined ? '' : ` · ${String(model.droppedRows)} evicted`}
        {model.unseenRows === undefined ? '' : ` · ${String(model.unseenRows)} new`}
      </Text>
      <Box flexDirection="column">
        {model.rows.map((row) => (
          <Box flexDirection="column" key={row.id}>
            <Text wrap="truncate-end">
              {model.focusedRowId === row.id ? '› ' : ''}
              {ROW_PREFIX[row.kind]} {row.toolCard?.title ?? row.content}
              {row.status === undefined ? '' : ROW_STATUS[row.status]}
            </Text>
            {row.toolCard?.lines.map((line, index) => (
              <Text dimColor key={`${row.id}:detail:${String(index)}`} wrap="truncate-end">
                {'  '}{line}
              </Text>
            ))}
            {row.toolCard?.truncated === true ? <Text dimColor>  [card truncated]</Text> : null}
          </Box>
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
  readonly interaction?: InteractionStore
  readonly modelLabel?: string
  readonly sessionId: string
  readonly status: ScreenModel['status']
  readonly terminalRows: number
  readonly workspace?: string
}

const EMPTY_INTERACTION_STORE: InteractionStore = {
  getSnapshot: () => undefined,
  subscribe: () => () => undefined,
}

function interactionModal(snapshot: InteractionSnapshot): InteractionModal | undefined {
  if (snapshot === undefined) return undefined
  if (snapshot.kind === 'approval') {
    return {
      agentLabel: snapshot.agentLabel,
      message: [snapshot.toolName, snapshot.reason].filter(Boolean).join(' · '),
      title: 'Approval',
    }
  }
  return {
    agentLabel: snapshot.agentLabel,
    message: snapshot.questions.map(question => [
      question.header ?? question.id,
      question.question,
      question.detail,
      ...(question.options ?? []).map(option =>
        option.description === undefined
          ? `[ ] ${option.label}`
          : `[ ] ${option.label} — ${option.description}`),
    ].filter(Boolean).join('\n')).join('\n\n'),
    title: snapshot.questions.some(question => question.intent?.kind === 'plan-review')
      ? 'Plan review'
      : 'Question',
  }
}

export function TranscriptFrame({
  columns,
  controller,
  interaction = EMPTY_INTERACTION_STORE,
  modelLabel,
  sessionId,
  status,
  terminalRows,
  workspace,
}: TranscriptFrameProps) {
  const transcript = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const pendingInteraction = useSyncExternalStore(
    interaction.subscribe,
    interaction.getSnapshot,
    interaction.getSnapshot,
  )
  const modal = interactionModal(pendingInteraction)

  return (
    <Frame
      columns={columns}
      model={createScreenModel(
        transcript.rows,
        {
          ...(modal === undefined
            ? {}
            : { modalRows: modal.message.split('\n').length + 2 }),
          ...(modelLabel === undefined ? {} : { modelLabel }),
          sessionId,
          status,
          terminalRows,
          ...(workspace === undefined ? {} : { workspace }),
        },
        modal,
      )}
    />
  )
}

export function renderInkFrame(model: ScreenModel, columns: number): string {
  return renderToString(<Frame columns={columns} model={model} />, { columns })
}
