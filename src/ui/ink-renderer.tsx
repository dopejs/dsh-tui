import { useSyncExternalStore } from 'react'
import { Box, Text, renderToString } from 'ink'

import type { TranscriptStore } from '../model/transcript-controller'
import type { InteractionSnapshot, InteractionStore } from '../model/interaction-controller'
import type { InteractionModal, ScreenModel, TranscriptRowKind } from '../model/view-model'
import { createScreenModel } from '../model/view-model'
import { compactCount, contextGauge, describeSources } from '../model/status-bar'
import { foldInjectedContent, foldSummary } from '../model/context-fold'
import { toneStyle, type SemanticTone } from './theme'
import { MarkdownInline, MarkdownView, splitLeadingText } from './markdown-view'
import { DEFAULT_TIPS, Welcome } from './welcome'

/**
 * Role markers. A single letter is unambiguous but reads as noise; these are
 * still one cell wide, so the transcript stays column-aligned.
 */
export const ROW_MARKERS: Record<TranscriptRowKind, string> = {
  assistant: '⏺',
  system: 'ℹ',
  tool: '⚒',
  user: '❯',
}

/** The glyph marking the focused row; kept distinct from every role marker. */
export const FOCUS_MARKER = '› '

const ROW_TONE: Record<TranscriptRowKind, SemanticTone | undefined> = {
  assistant: 'accent',
  system: 'muted',
  tool: undefined,
  user: undefined,
}

interface FrameProps {
  readonly columns: number
  /** Rows the user expanded; injected context is folded until then. */
  readonly expandedRowIds?: ReadonlySet<string>
  readonly model: ScreenModel
}

const ROW_STATUS: Record<NonNullable<ScreenModel['rows'][number]['status']>, string> = {
  complete: '',
  error: ' [error]',
  pending: ' [pending]',
  streaming: ' [streaming]',
}

function metadata(model: ScreenModel, columns: number): readonly string[] {
  const permission = model.permissionPreset === undefined
    ? (model.approvalPolicy === undefined ? undefined : `approval ${model.approvalPolicy}`)
    : `permission ${model.permissionPreset}`
  const usage = model.totalTokens === undefined ? undefined : `tokens ${String(model.totalTokens)}`
  const context = model.contextWindow === undefined ? undefined : `ctx ${String(model.contextWindow)}`
  // Pending activity outranks usage and workspace: it is the only actionable count.
  const activity = model.activityCount === undefined
    ? undefined
    : `activity ${String(model.activityCount)}`
  if (columns < 60) {
    return [model.modelLabel, activity, permission]
      .filter((value): value is string => value !== undefined)
  }
  if (columns < 100) {
    return [model.modelLabel, activity, permission, usage, context]
      .filter((value): value is string => value !== undefined)
  }
  return [model.modelLabel, activity, permission, usage, context, model.workspace]
    .filter((value): value is string => value !== undefined)
}

export function Frame({ columns, expandedRowIds, model }: FrameProps) {
  const theme = model.welcome?.theme ?? 'default'
  const tone = (name: SemanticTone | undefined) => toneStyle(theme, name)
  // Only drawn when usage is actually known: an empty bar labelled 0% asserts
  // "nothing consumed", when the truth may be "not reported".
  const gauge = model.contextUsed === undefined
    ? undefined
    : contextGauge(model.contextUsed, model.contextWindow)
  const sources = describeSources(model.contextSources ?? [])
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold wrap="truncate-end">
        dsh-tui · {model.sessionId} · {model.status}
      </Text>
      {metadata(model, columns).length === 0 ? null : (
        <Text dimColor wrap="truncate-end">
          {metadata(model, columns).join(' · ')}
        </Text>
      )}
      {gauge === undefined ? null : (
        <Text wrap="truncate-end">
          <Text dimColor>Context </Text>
          <Text color={gauge.pressured ? 'yellow' : 'cyan'}>{gauge.bar}</Text>
          <Text dimColor> {String(gauge.percent)}%</Text>
          <Text dimColor> · {compactCount(model.contextUsed ?? 0)} tokens</Text>
        </Text>
      )}
      {sources === undefined ? null : (
        <Text dimColor wrap="truncate-end">{sources}</Text>
      )}
      {/* A terminal that shows nothing while a model thinks reads as hung. */}
      {model.working === undefined ? null : (
        <Text {...tone('accent')} wrap="truncate-end">
          working · {model.working.join(' · ')}
        </Text>
      )}
      <Text dimColor>
        {model.visibleRange === undefined
          ? 'transcript empty'
          : `transcript ${model.visibleRange.start}–${model.visibleRange.end} of ${model.totalRows}`}
        {model.droppedRows === undefined ? '' : ` · ${String(model.droppedRows)} evicted`}
        {model.unseenRows === undefined ? '' : ` · ${String(model.unseenRows)} new`}
      </Text>
      {model.firstScreen === true && model.welcome !== undefined ? (
        <Welcome
          columns={columns}
          cwd={model.welcome.cwd}
          {...(model.modelLabel === undefined ? {} : { modelLabel: model.modelLabel })}
          {...(model.permissionPreset === undefined
            ? {}
            : { permission: model.permissionPreset })}
          screenReader={model.welcome.screenReader}
          theme={model.welcome.theme}
          tips={DEFAULT_TIPS}
          version={model.welcome.version}
        />
      ) : null}
      <Box flexDirection="column">
        {model.rows.map((row) => {
          // Injected context is folded so a session does not open on a wall of
          // instructions; the content stays reachable, not discarded.
          const injected = row.kind === 'system' && row.toolCard === undefined
            ? foldInjectedContent(row.content, expandedRowIds?.has(row.id) === true)
            : undefined
          const prose = row.kind === 'assistant' && row.toolCard === undefined
            ? splitLeadingText(row.content)
            : undefined
          return (
          <Box flexDirection="column" key={row.id}>
            <Text {...tone(ROW_TONE[row.kind])} wrap="truncate-end">
              {model.focusedRowId === row.id ? FOCUS_MARKER : ''}
              {ROW_MARKERS[row.kind]}
              {' '}
              {/* Only assistant prose is Markdown; a user turn and a tool card
                  are shown as written, since interpreting them would change
                  what the user typed or what the tool reported. */}
              {prose === undefined
                ? row.toolCard?.title ?? injected?.lines[0] ?? row.content
                : prose.lead === undefined
                  ? ''
                  : <MarkdownInline text={prose.lead} theme={theme} />}
              {row.status === undefined ? '' : ROW_STATUS[row.status]}
            </Text>
            {/* Scratch work, folded by default: a human may want it, but it is
                not the answer and must not be mistaken for one. */}
            {row.reasoning === undefined ? null : expandedRowIds?.has(row.id) === true ? (
              <Box flexDirection="column" marginLeft={2}>
                {row.reasoning.split('\n').map((line, index) => (
                  <Text {...tone('muted')} key={index} wrap="truncate-end">{line}</Text>
                ))}
              </Box>
            ) : (
              <Text {...tone('muted')} wrap="truncate-end">
                {'  '}reasoning hidden · ^E show
              </Text>
            )}
            {prose !== undefined && prose.rest.length > 0 ? (
              <Box marginLeft={2}>
                <MarkdownView blocks={prose.rest} theme={theme} />
              </Box>
            ) : null}
            {injected !== undefined && injected.folded ? (
              <Text dimColor wrap="truncate-end">
                {'  '}{foldSummary(injected.hiddenLines)}
              </Text>
            ) : null}
            {injected !== undefined && !injected.folded
              ? injected.lines.slice(1).map((line, index) => (
                <Text dimColor key={`${row.id}:ctx:${String(index)}`} wrap="truncate-end">
                  {'  '}{line}
                </Text>
              ))
              : null}
            {row.toolCard?.lines.map((line, index) => (
              <Text dimColor key={`${row.id}:detail:${String(index)}`} wrap="truncate-end">
                {'  '}{line}
              </Text>
            ))}
            {row.toolCard?.truncated === true ? <Text dimColor>  [card truncated]</Text> : null}
          </Box>
          )
        })}
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

export function renderInkFrame(
  model: ScreenModel,
  columns: number,
  expandedRowIds?: ReadonlySet<string>,
): string {
  return renderToString(
    <Frame
      columns={columns}
      {...(expandedRowIds === undefined ? {} : { expandedRowIds })}
      model={model}
    />,
    { columns },
  )
}
