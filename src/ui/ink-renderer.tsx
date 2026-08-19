import { useSyncExternalStore } from 'react'
import { Box, Text, renderToString } from 'ink'
import stringWidth from 'string-width'

import type { TranscriptStore } from '../model/transcript-controller'
import type { InteractionSnapshot, InteractionStore } from '../model/interaction-controller'
import type { InteractionModal, ScreenModel, TranscriptRowKind } from '../model/view-model'
import { createScreenModel } from '../model/view-model'
import { compactCount, contextGauge, describeSources } from '../model/status-bar'
import { formatElapsed } from '../model/working-status'
import { foldInjectedContent, foldSummary } from '../model/context-fold'
import { bandStyle, bandsUserTurn, toneStyle, type SemanticTone } from './theme'
import { MarkdownInline, MarkdownView, splitLeadingText } from './markdown-view'
import { DEFAULT_TIPS, Welcome } from './welcome'

/**
 * Role markers. A single letter is unambiguous but reads as noise; these are
 * still one cell wide, so the transcript stays column-aligned.
 */
export const ROW_MARKERS: Record<TranscriptRowKind, string> = {
  assistant: '⏺',
  context: '⋯',
  system: 'ℹ',
  tool: '⚒',
  user: '❯',
}

/**
 * Pads a line so a band spans the terminal rather than stopping at the text.
 *
 * Measured in cells, not code units: a CJK turn is twice as wide as its length
 * suggests, and padding by length would run the band past the right edge.
 */
function padToWidth(text: string, columns: number): string {
  const used = stringWidth(text)
  return used >= columns ? text : text + ' '.repeat(columns - used)
}

/** The glyph marking the focused row; kept distinct from every role marker. */
export const FOCUS_MARKER = '› '

/**
 * The working line's marker, one cell like every role marker so the foot of
 * the conversation stays column-aligned with the rows above it.
 */
export const WORKING_MARKER = '· '

const ROW_TONE: Record<TranscriptRowKind, SemanticTone | undefined> = {
  assistant: 'accent',
  context: 'muted',
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

/**
 * The status chrome, drawn below the composer.
 *
 * It used to sit above the transcript, which pushed the conversation down the
 * screen and put five lines of session metadata where the first thing you read
 * should be. Claude Code keeps the conversation at the top and the status where
 * the cursor already is; this follows that, and the status stays next to the
 * composer it describes.
 */
export function StatusFooter({ columns, model }: FrameProps) {
  // Only drawn when usage is actually known: an empty bar labelled 0% asserts
  // "nothing consumed", when the truth may be "not reported".
  const gauge = model.contextUsed === undefined
    ? undefined
    : contextGauge(model.contextUsed, model.contextWindow)
  const sources = describeSources(model.contextSources ?? [])
  // Two lines, not five. Identity and route on the first, consumption and
  // position on the second. Five lines of chrome under the composer is the
  // same clutter the header used to be, just moved.
  const identity = [`dsh-tui · ${model.sessionId} · ${model.status}`, ...metadata(model, columns)]
  const position = [
    model.visibleRange === undefined
      ? 'transcript empty'
      : `transcript ${model.visibleRange.start}–${model.visibleRange.end} of ${model.totalRows}`,
    ...(model.droppedRows === undefined ? [] : [`${String(model.droppedRows)} evicted`]),
    ...(model.hiddenContextRows === undefined
      ? []
      : [`${String(model.hiddenContextRows)} context hidden`]),
    ...(model.unseenRows === undefined ? [] : [`${String(model.unseenRows)} new`]),
    ...(sources === undefined ? [] : [sources]),
  ]
  return (
    <Box flexDirection="column" width={columns}>
      <Text dimColor wrap="truncate-end">{identity.join(' · ')}</Text>
      <Text wrap="truncate-end">
        {gauge === undefined ? null : (
          <Text>
            <Text color={gauge.pressured ? 'yellow' : 'cyan'}>{gauge.bar}</Text>
            <Text dimColor> {String(gauge.percent)}% · {compactCount(model.contextUsed ?? 0)} tokens · </Text>
          </Text>
        )}
        <Text dimColor>{position.join(' · ')}</Text>
      </Text>
    </Box>
  )
}

export function Frame({ columns, expandedRowIds, model }: FrameProps) {
  const theme = model.welcome?.theme ?? 'default'
  const tone = (name: SemanticTone | undefined) => toneStyle(theme, name)
  return (
    <Box flexDirection="column" width={columns}>
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
          {...(model.welcome.headingText === undefined
            ? {}
            : { headingText: model.welcome.headingText })}
          tips={model.welcome.tips ?? DEFAULT_TIPS}
          version={model.welcome.version}
        />
      ) : null}
      <Box flexDirection="column">
        {model.rows
          .filter(row => model.showContext === true || row.kind !== 'context')
          .map((row, index) => {
          // Injected context is folded so a session does not open on a wall of
          // instructions; the content stays reachable, not discarded.
          const injected = row.kind === 'context' && row.toolCard === undefined
            ? foldInjectedContent(row.content, expandedRowIds?.has(row.id) === true)
            : undefined
          const prose = row.kind === 'assistant' && row.toolCard === undefined
            ? splitLeadingText(row.content)
            : undefined
          return (
          <Box flexDirection="column" key={row.id}>
            {/* One blank line between exchanges. Packed edge to edge, the
                transcript reads as a single block of text and the eye has
                nowhere to rest between one turn and the next. */}
            {index === 0 ? null : <Box height={1} />}
            {/*
              * Scratch work, above the answer and never inside it.
              *
              * Drawn between the answer's first line and the rest of it, this
              * cut one reply in half around a note about deliberation. The
              * durable log emits reasoning before the text block, and it reads
              * in that order too: the thinking first, folded; then the answer,
              * whole.
              */}
            {row.reasoning === undefined ? null : expandedRowIds?.has(row.id) === true ? (
              <Box flexDirection="column" marginLeft={2}>
                {row.reasoning.split('\n').map((line, index) => (
                  <Text {...tone('muted')} key={index} wrap="truncate-end">{line}</Text>
                ))}
              </Box>
            ) : (
              <Text {...tone('muted')} wrap="truncate-end">
                {'  '}
                {/* How long it thought, once that is known. A turn that paused
                    for eight seconds and one that answered instantly are not
                    the same event, and the transcript should not read as
                    though they were. */}
                {row.reasoningMs === undefined
                  ? ''
                  : `thought for ${formatElapsed(row.reasoningMs)} · `}
                {/* No chord named here: the line is clickable, and naming a
                    key as well as offering the click makes the interface
                    explain two ways to do one thing. Ctrl-E still works. */}
                {model.welcome?.reasoningHiddenText ?? 'reasoning hidden'}
              </Text>
            )}
            {/*
              * A user turn is drawn as a band across the full width. Without
              * it every row began the same way and the eye had nothing to
              * land on: finding where an exchange started meant reading.
              */}
            {row.kind === 'user' ? (
              <Text {...bandStyle(theme)} wrap="truncate-end">
                {(() => {
                  const line = `${model.focusedRowId === row.id ? FOCUS_MARKER : ''}`
                    + `${ROW_MARKERS[row.kind]} ${row.content}`
                  // Padded only when a band is drawn: trailing spaces behind no
                  // background are invisible work.
                  return bandsUserTurn(theme) ? padToWidth(line, columns) : line
                })()}
              </Text>
            ) : (
            // The role tone belongs to the marker, not to the words. Applied to
            // the whole line it coloured only an answer's first paragraph --
            // the one drawn here -- while every paragraph after it went through
            // the Markdown view untinted, so a reply changed colour halfway
            // through for no reason a reader could infer.
            <Text
              {...(row.kind === 'assistant' ? {} : tone(ROW_TONE[row.kind]))}
              wrap="truncate-end"
            >
              {model.focusedRowId === row.id ? FOCUS_MARKER : ''}
              <Text {...tone(ROW_TONE[row.kind])}>{ROW_MARKERS[row.kind]}</Text>
              {' '}
              {/* Only assistant prose is Markdown; a user turn and a tool card
                  are shown as written, since interpreting them would change
                  what the user typed or what the tool reported. */}
              {prose === undefined
                ? row.toolCard?.title ?? injected?.lines[0] ?? row.content
                : prose.lead === undefined
                  ? ''
                  : <MarkdownInline text={prose.lead} theme={theme} />}
              {/* The fold summary rides on the same line. Given as its own
                  row it doubled every injection's footprint, so a turn that
                  carried three reminders spent six lines saying nothing the
                  user asked for. */}
              {injected !== undefined && injected.folded ? (
                <Text dimColor> · {foldSummary(injected.hiddenLines)}</Text>
              ) : null}
              {row.status === undefined ? '' : ROW_STATUS[row.status]}
            </Text>
            )}
            {prose !== undefined && prose.rest.length > 0 ? (
              <Box marginLeft={2}>
                <MarkdownView blocks={prose.rest} theme={theme} />
              </Box>
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
        {/*
          * The working line sits at the foot of the conversation, where the
          * reply is about to appear -- not in the status area. A model thinking
          * is part of the exchange you are reading, and a terminal that reports
          * it three lines below the composer makes you look away from the place
          * you are waiting on.
          */}
        {model.working === undefined ? null : (
          <Text {...tone('accent')} wrap="truncate-end">
            {WORKING_MARKER}working · {model.working.join(' · ')}
          </Text>
        )}
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
  // Mirrors the real screen order: conversation first, status underneath.
  return renderToString(
    <Box flexDirection="column">
      <Frame
        columns={columns}
        {...(expandedRowIds === undefined ? {} : { expandedRowIds })}
        model={model}
      />
      <StatusFooter columns={columns} model={model} />
    </Box>,
    { columns },
  )
}
