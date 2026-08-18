import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, usePaste, useStdout } from 'ink'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

import type { ActivityCenterController } from '../model/activity-center-controller'
import type { AttachmentsController } from '../model/attachments-controller'
import type { AgentStatusStore } from '../model/agent-status-controller'
import type { ChangeIndexController } from '../model/change-index-controller'
import type {
  CommandPaletteController,
  PaletteItem,
  TuiActionId,
} from '../model/command-palette-controller'
import type { CompletionController } from '../model/completion-controller'
import type { EditorController } from '../model/editor-controller'
import type {
  InteractionController,
  InteractionQuestion,
  InteractionSnapshot,
} from '../model/interaction-controller'
import type { TranscriptStore } from '../model/transcript-controller'
import type { OverlayController } from '../model/overlay-controller'
import { resolveInputSurface } from '../model/overlay-controller'
import type { SessionCenterController } from '../model/session-center-controller'
import type { RuntimeStatusController } from '../model/runtime-status-controller'
import type { RecoveryController } from '../model/recovery-controller'
import type { PreferencesController } from '../model/preferences-controller'
import type { PermissionController } from '../model/permission-controller'
import type { JobsController } from '../model/jobs-controller'
import type { McpInventoryController } from '../model/mcp-inventory-controller'
import type { PluginInventoryController } from '../model/plugin-inventory-controller'
import type { SkillsController } from '../model/skills-controller'
import type { ProjectionHubController } from '../model/projection-hub-controller'
import type { SubagentTreeController } from '../model/subagent-tree-controller'
import type {
  TranscriptViewportController,
  TranscriptViewportSnapshot,
} from '../model/transcript-viewport-controller'
import { projectTranscriptPlainText } from '../model/transcript-viewport-controller'
import { createScreenModel, type InteractionModal } from '../model/view-model'
import { workingStatus } from '../model/working-status'
import type { InputController, InputSubmission, SubmissionMode } from '../runtime/input-controller'
import { Composer, createComposerView } from './composer'

/**
 * The empty-composer hint. It names a real task rather than describing the
 * box, because the first thing a new user needs is an example of what to say.
 */
const COMPOSER_PLACEHOLDER = 'Try "explain this repository" · ^P for the command palette'
import { writeOsc52Clipboard } from './clipboard'
import { Frame } from './ink-renderer'
import { OverlayPanel } from './overlay'
import { TUI_VERSION } from './version'
import type { TerminalCapabilities } from './terminal-links'

interface QuestionDraft {
  readonly custom?: string
  readonly id: string
  readonly selected: readonly string[]
}

export interface InteractiveTuiProps {
  readonly acceptsInput?: () => boolean
  readonly activity: ActivityCenterController
  readonly attachments: AttachmentsController
  /** Reads a file for attachment; injected so the model layer stays pure. */
  readonly readFile?: (path: string) => Promise<Uint8Array>
  /** Negotiated once at startup; drives hyperlinks and inline images. */
  readonly terminalCapabilities?: TerminalCapabilities
  readonly changes: ChangeIndexController
  readonly columns?: number
  readonly completion: CompletionController
  readonly editor: EditorController
  readonly input: InputController
  /** No persisted session was found, so this is a first run. */
  readonly firstRun?: boolean
  readonly initialNotice?: string
  readonly interaction: InteractionController
  readonly jobs: JobsController
  readonly mcp: McpInventoryController
  readonly modelLabel: string
  readonly onQuit: (code: number) => void
  readonly overlay: OverlayController
  readonly palette: CommandPaletteController
  readonly permission: PermissionController
  readonly plugins: PluginInventoryController
  readonly preferences: PreferencesController
  readonly projections: ProjectionHubController
  readonly recovery: RecoveryController
  readonly sessionId: string
  readonly sessionCenter: SessionCenterController
  readonly skills: SkillsController
  readonly runtimeStatus: RuntimeStatusController
  readonly status: AgentStatusStore
  readonly subagents: SubagentTreeController
  readonly terminalRows?: number
  readonly transcript: TranscriptStore
  readonly viewport: TranscriptViewportController
  readonly workspace: string
}

function removeLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join('')
}

function submissionNotice(submission: InputSubmission): string {
  switch (submission.kind) {
    case 'message': {
      const queued = submission.mode === 'steer' ? 'Steering queued.' : 'Message queued.'
      const refused = (submission.references ?? []).filter(entry => entry.kind === 'refused')
      const attached = (submission.references ?? []).filter(entry => entry.kind !== 'refused')
      // A refused reference is reported: the user believes the file went with
      // the message, and a silent drop is the one outcome they cannot detect.
      if (refused.length > 0) {
        return `${queued} Not sent: ${refused
          .map(entry => `${entry.path} (${entry.kind === 'refused' ? entry.reason : ''})`)
          .join(', ')}`
      }
      return attached.length === 0
        ? queued
        : `${queued} Included ${String(attached.length)} reference${attached.length === 1 ? '' : 's'}.`
    }
    case 'command':
      return submission.execution.result.text
        ?? (submission.execution.result.kind === 'success' ? 'Command completed.' : 'Command failed.')
    case 'command-cancelled':
      return 'Command cancelled.'
    case 'command-error':
    case 'message-error':
    case 'rejected':
      return submission.message
  }
}

function approvalModal(
  snapshot: Exclude<InteractionSnapshot, undefined> & { kind: 'approval' },
  changeContext: readonly string[],
) {
  return {
    agentLabel: snapshot.agentLabel,
    message: [
      snapshot.toolName,
      snapshot.reason,
      ...changeContext,
      'Y allow once · N reject',
    ].filter(Boolean).join('\n'),
    title: 'Approval',
  } satisfies InteractionModal
}

function questionModal(
  snapshot: Exclude<InteractionSnapshot, undefined> & { kind: 'questions' },
  questionIndex: number,
  cursor: number,
  selected: ReadonlySet<string>,
  customMode: boolean,
  customText: string,
): InteractionModal {
  const question = snapshot.questions[questionIndex]
  if (question === undefined) {
    return {
      agentLabel: snapshot.agentLabel,
      message: 'Waiting for question data.',
      title: 'Question',
    }
  }
  const options = question.options ?? []
  const lines = [
    `${String(questionIndex + 1)}/${String(snapshot.questions.length)} · ${question.header ?? question.id}`,
    question.question,
    question.detail,
    ...options.map((option, index) => {
      const marker = selected.has(option.label) ? 'x' : ' '
      const pointer = index === cursor && !customMode ? '>' : ' '
      const detail = option.description === undefined ? '' : ` — ${option.description}`
      return `${pointer} [${marker}] ${option.label}${detail}`
    }),
    customMode ? `> Other: ${customText}█` : 'Tab: Other · Enter: answer',
  ].filter((line): line is string => line !== undefined)
  return {
    agentLabel: snapshot.agentLabel,
    message: lines.join('\n'),
    title: question.intent?.kind === 'plan-review' ? 'Plan review' : 'Question',
  }
}

function modalRows(modal: InteractionModal | undefined): number {
  return modal === undefined ? 0 : modal.message.split('\n').length + 2
}

function appendTypedText(current: string, input: string): string {
  if (input === '' || input === '\r' || input === '\n') return current
  return current + input
}

function normalizeTerminalPaste(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function searchStatus(search: TranscriptViewportSnapshot['search']): string {
  if (search.query === '') {
    return `type to search retained transcript${search.incomplete ? ' · history evicted' : ''}`
  }
  const position = search.activeIndex === undefined ? 0 : search.activeIndex + 1
  const count = search.truncated
    ? `${String(search.totalMatches)} (showing ${String(search.matchIds.length)})`
    : String(search.totalMatches)
  return `${String(position)}/${count}${search.incomplete ? ' · retained window only' : ''}`
}

export function InteractiveTui({
  acceptsInput = () => true,
  activity,
  attachments,
  changes,
  columns: fixedColumns,
  completion,
  editor,
  firstRun = false,
  input,
  initialNotice,
  interaction,
  jobs,
  mcp,
  modelLabel,
  onQuit,
  overlay,
  palette,
  permission,
  plugins,
  preferences,
  projections,
  readFile,
  terminalCapabilities,
  recovery,
  sessionId,
  sessionCenter,
  skills,
  runtimeStatus,
  status,
  subagents,
  terminalRows: fixedRows,
  transcript,
  viewport,
  workspace,
}: InteractiveTuiProps) {
  const { stdout } = useStdout()
  const [dimensions, setDimensions] = useState(() => ({
    columns: fixedColumns ?? stdout.columns ?? 80,
    rows: fixedRows ?? stdout.rows ?? 24,
  }))
  const [notice, setNotice] = useState(
    initialNotice ?? (firstRun
      // A first-run user has no way to discover the panels yet; the palette is
      // the one shortcut that leads to all of them.
      ? 'Welcome. ^P opens the command palette — every action is listed there. Enter sends.'
      : 'Enter send · ^J newline · ^S steer · ^C cancel'),
  )
  // Injected context is folded by default; expansion is per-row and lives in
  // presentation state, never in the durable log.
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(() => new Set())
  // When the current turn began, so the working row can report elapsed time.
  // Reset on each idle→running transition rather than accumulated, so a second
  // turn does not inherit the first one's clock.
  const [turnStartedAt, setTurnStartedAt] = useState<number | undefined>(undefined)
  // The clock itself is state, not a tick counter: the elapsed value is then
  // genuinely read where it is rendered rather than forced by a dummy update.
  const [now, setNow] = useState(() => Date.now())
  const [questionIndex, setQuestionIndex] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [customMode, setCustomMode] = useState(false)
  const [customText, setCustomText] = useState('')
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>([])
  const transcriptSnapshot = useSyncExternalStore(
    transcript.subscribe,
    transcript.getSnapshot,
    transcript.getSnapshot,
  )
  const changeSnapshot = useSyncExternalStore(
    changes.subscribe,
    changes.getSnapshot,
    changes.getSnapshot,
  )
  const interactionSnapshot = useSyncExternalStore(
    interaction.subscribe,
    interaction.getSnapshot,
    interaction.getSnapshot,
  )
  const agentStatus = useSyncExternalStore(
    status.subscribe,
    status.getSnapshot,
    status.getSnapshot,
  )
  const editorSnapshot = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
    editor.getSnapshot,
  )
  const viewportSnapshot = useSyncExternalStore(
    viewport.subscribe,
    viewport.getSnapshot,
    viewport.getSnapshot,
  )
  const overlaySnapshot = useSyncExternalStore(
    overlay.subscribe,
    overlay.getSnapshot,
    overlay.getSnapshot,
  )
  const paletteSnapshot = useSyncExternalStore(
    palette.subscribe,
    palette.getSnapshot,
    palette.getSnapshot,
  )
  const completionSnapshot = useSyncExternalStore(
    completion.subscribe,
    completion.getSnapshot,
    completion.getSnapshot,
  )
  const sessionCenterSnapshot = useSyncExternalStore(
    sessionCenter.subscribe,
    sessionCenter.getSnapshot,
    sessionCenter.getSnapshot,
  )
  const permissionSnapshot = useSyncExternalStore(
    permission.subscribe,
    permission.getSnapshot,
    permission.getSnapshot,
  )
  const runtimeStatusSnapshot = useSyncExternalStore(
    runtimeStatus.subscribe,
    runtimeStatus.getSnapshot,
    runtimeStatus.getSnapshot,
  )
  const recoverySnapshot = useSyncExternalStore(
    recovery.subscribe,
    recovery.getSnapshot,
    recovery.getSnapshot,
  )
  const projectionSnapshot = useSyncExternalStore(
    projections.subscribe,
    projections.getSnapshot,
    projections.getSnapshot,
  )
  const jobsSnapshot = useSyncExternalStore(
    jobs.subscribe,
    jobs.getSnapshot,
    jobs.getSnapshot,
  )
  const subagentSnapshot = useSyncExternalStore(
    subagents.subscribe,
    subagents.getSnapshot,
    subagents.getSnapshot,
  )
  const activitySnapshot = useSyncExternalStore(
    activity.subscribe,
    activity.getSnapshot,
    activity.getSnapshot,
  )
  const mcpSnapshot = useSyncExternalStore(
    mcp.subscribe,
    mcp.getSnapshot,
    mcp.getSnapshot,
  )
  const pluginSnapshot = useSyncExternalStore(
    plugins.subscribe,
    plugins.getSnapshot,
    plugins.getSnapshot,
  )
  const skillSnapshot = useSyncExternalStore(
    skills.subscribe,
    skills.getSnapshot,
    skills.getSnapshot,
  )
  const attachmentSnapshot = useSyncExternalStore(
    attachments.subscribe,
    attachments.getSnapshot,
    attachments.getSnapshot,
  )
  const preferenceSnapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
    preferences.getSnapshot,
  )

  // Start the clock on idle→running and clear it on the way back, so a second
  // turn never inherits the first one's start time.
  useEffect(() => {
    // A state updater must stay pure, so the clock is set alongside it rather
    // than from inside it.
    if (agentStatus === 'running') {
      const startedAt = Date.now()
      setTurnStartedAt(current => current ?? startedAt)
      setNow(startedAt)
    } else setTurnStartedAt(undefined)
  }, [agentStatus])

  // Re-render once a second only while work is in flight; an idle session must
  // not hold a timer, and reduced motion opts out of the ticking entirely.
  useEffect(() => {
    if (agentStatus !== 'running' || preferenceSnapshot.reducedMotion) return undefined
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1_000)
    return () => {
      clearInterval(timer)
    }
  }, [agentStatus, preferenceSnapshot.reducedMotion])

  useEffect(() => {
    if (fixedColumns !== undefined && fixedRows !== undefined) return
    const resize = () => {
      setDimensions({
        columns: fixedColumns ?? stdout.columns ?? 80,
        rows: fixedRows ?? stdout.rows ?? 24,
      })
    }
    stdout.on('resize', resize)
    return () => {
      stdout.off('resize', resize)
    }
  }, [fixedColumns, fixedRows, stdout])

  useEffect(() => {
    setQuestionIndex(0)
    setCursor(0)
    setSelected(new Set())
    setCustomMode(false)
    setCustomText('')
    setDrafts([])
  }, [interactionSnapshot])

  useEffect(() => {
    if (interactionSnapshot?.kind !== 'questions') return
    const question = interactionSnapshot.questions[questionIndex]
    if ((question?.options?.length ?? 0) === 0) setCustomMode(true)
  }, [interactionSnapshot, questionIndex])

  const modal = useMemo(() => {
    if (interactionSnapshot === undefined) return undefined
    return interactionSnapshot.kind === 'approval'
      ? approvalModal(interactionSnapshot, changes.approvalContext(interactionSnapshot.callId))
      : questionModal(
          interactionSnapshot,
          questionIndex,
          cursor,
          selected,
          customMode,
          customText,
        )
  }, [changeSnapshot, changes, cursor, customMode, customText, interactionSnapshot, questionIndex, selected])

  const submitComposer = async (mode: SubmissionMode) => {
    const draft = editor.captureSubmission()
    const submission = await input.submit(draft.text, mode)
    if (
      submission.kind === 'message'
      || (submission.kind === 'command' && submission.execution.result.kind === 'success')
    ) {
      editor.acceptSubmission(draft)
    }
    setNotice(submissionNotice(submission))
  }

  const finishQuestion = (question: InteractionQuestion, draft: QuestionDraft) => {
    if (interactionSnapshot?.kind !== 'questions') return
    const nextDrafts = [...drafts, draft]
    if (questionIndex + 1 < interactionSnapshot.questions.length) {
      setDrafts(nextDrafts)
      setQuestionIndex(index => index + 1)
      setCursor(0)
      setSelected(new Set())
      setCustomMode(false)
      setCustomText('')
      return
    }
    const answer: AskUserQuestionAnswer = {
      answers: nextDrafts.map(item => ({
        id: item.id,
        selected: [...item.selected],
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      })),
    }
    try {
      interaction.answerQuestions(answer)
      setNotice('Questions answered.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const copyVisibleTranscript = () => {
    const plain = projectTranscriptPlainText(screen.rows, 100_000)
    const result = writeOsc52Clipboard(stdout, plain.text)
    setNotice(result === 'sent'
      ? `Visible transcript copied${plain.truncated ? ' with truncation' : ''}.`
      : result === 'too-large'
        ? 'Visible transcript is too large for terminal clipboard transfer.'
        : 'Terminal clipboard transfer is unavailable.')
  }

  const executeTuiAction = (action: TuiActionId) => {
    switch (action) {
      case 'changes.center':
        overlay.open('changes')
        setNotice('Changes opened.')
        return
      case 'composer.clear':
        setNotice(editor.clear() ? 'Composer cleared.' : 'Composer is already empty.')
        return
      case 'jobs.center':
        jobs.refresh()
        overlay.open('jobs')
        setNotice('Jobs opened.')
        return
      case 'plugin.center':
        plugins.refresh()
        overlay.open('plugins')
        setNotice('Plugins opened.')
        return
      case 'mcp.center':
        mcp.refresh()
        overlay.open('mcp')
        setNotice('MCP inventory opened.')
        return
      case 'skill.center':
        void skills.refresh()
        overlay.open('skills')
        setNotice('Skills opened.')
        return
      case 'attachment.center':
        overlay.open('attachments')
        setNotice('Attachments opened.')
        return
      case 'activity.center':
        activity.refresh()
        overlay.open('activity')
        setNotice('Activity opened.')
        return
      case 'subagent.center':
        void subagents.refresh()
        overlay.open('subagents')
        setNotice('Subagents opened.')
        return
      case 'permission.center':
        overlay.open('permissions')
        setNotice('Permissions opened.')
        return
      case 'projection.center':
        overlay.open('projections')
        setNotice('Projections opened.')
        return
      case 'recovery.center':
        overlay.open('recovery')
        setNotice('Recovery opened.')
        return
      case 'session.center':
        sessionCenter.resetQuery()
        sessionCenter.refresh()
        overlay.open('session-center')
        setNotice('Session center opened.')
        return
      case 'transcript.compact-tools':
        viewport.toggleCompactTools()
        setNotice('Tool card density toggled.')
        return
      case 'transcript.copy-visible':
        copyVisibleTranscript()
        return
      case 'transcript.search':
        viewport.openSearch()
        setNotice('Transcript search opened.')
        return
      case 'transcript.to-end':
        viewport.toEnd()
        setNotice('Following the live transcript tail.')
        return
      case 'transcript.to-start':
        viewport.toStart()
        setNotice('Moved to the oldest retained transcript row.')
        return
      case 'tui.exit':
        onQuit(0)
    }
  }

  const choosePaletteItem = (item: PaletteItem | undefined) => {
    if (item === undefined) {
      setNotice('No palette item is selected.')
      return
    }
    overlay.close('command-palette')
    if (item.kind === 'action') {
      executeTuiAction(item.action)
      return
    }
    if (editor.getSnapshot().text !== '') {
      setNotice(`Composer draft retained; clear it before selecting /${item.name}.`)
      return
    }
    const invocation = `/${item.name}${item.inputHint === undefined ? '' : ' '}`
    if (editor.insert(invocation) === 'limit-exceeded') {
      setNotice(`Command exceeds ${String(editor.textLimit)} code units.`)
      return
    }
    if (item.inputHint !== undefined) {
      setNotice(`Complete the ${item.inputHint} argument and press Enter.`)
      return
    }
    void submitComposer('followup').catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  const applySelectedCompletion = () => {
    const selectedCompletion = completion.selected()
    if (selectedCompletion === undefined) {
      setNotice('No completion is selected.')
      return
    }
    try {
      const result = editor.replaceRange(
        selectedCompletion.start,
        selectedCompletion.end,
        selectedCompletion.replacement,
      )
      setNotice(result === 'limit-exceeded'
        ? `Completion exceeds ${String(editor.textLimit)} code units.`
        : 'Completion applied.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      completion.cancel()
      overlay.close('completion')
    }
  }

  usePaste((pasted) => {
    if (!acceptsInput()) return
    const normalized = normalizeTerminalPaste(pasted)
    if (interactionSnapshot?.kind === 'approval') return
    if (interactionSnapshot?.kind === 'questions') {
      if (!customMode) {
        setNotice('Press Tab before pasting an Other answer.')
        return
      }
      setCustomText((current) => {
        if (current.length + normalized.length > editor.textLimit) {
          setNotice(`Other answer exceeds ${String(editor.textLimit)} code units.`)
          return current
        }
        return current + normalized
      })
      return
    }
    const pasteSurface = resolveInputSurface(overlay.getSnapshot(), {
      interactionActive: false,
      searchOpen: viewport.getSnapshot().search.open,
    })
    if (pasteSurface === 'overlay') {
      if (overlay.getSnapshot().active === 'command-palette') {
        if (palette.insertQuery(normalized.replaceAll('\n', ' ')) === 'limit-exceeded') {
          setNotice('Palette query is too long.')
        }
        return
      }
      if (overlay.getSnapshot().active === 'session-center') {
        if (sessionCenter.insertQuery(normalized.replaceAll('\n', ' ')) === 'limit-exceeded') {
          setNotice('Session filter is too long.')
        }
        return
      }
      if (overlay.getSnapshot().active === 'permissions') {
        if (permission.getSnapshot().status !== 'confirming') return
        if (permission.insertConfirmation(normalized) === 'limit-exceeded') {
          setNotice('Permission confirmation is too long.')
        }
        return
      }
      if (overlay.getSnapshot().active === 'recovery') {
        if (recovery.getSnapshot().status !== 'export-input') return
        if (recovery.insertDestination(normalized) === 'limit-exceeded') {
          setNotice('Export destination is too long.')
        }
        return
      }
      completion.cancel()
      overlay.close('completion')
      const result = editor.insert(normalized)
      setNotice(result === 'limit-exceeded'
        ? `Composer exceeds ${String(editor.textLimit)} code units.`
        : `Pasted ${String(normalized.length)} code units.`)
      return
    }
    if (viewport.getSnapshot().search.open) {
      const result = viewport.insertSearch(normalized.replaceAll('\n', ' '))
      if (result === 'limit-exceeded') setNotice('Search query is too long.')
      return
    }
    const result = editor.insert(normalized)
    setNotice(result === 'limit-exceeded'
      ? `Composer exceeds ${String(editor.textLimit)} code units.`
      : `Pasted ${String(normalized.length)} code units.`)
  })

  useInput((typed, key) => {
    if (!acceptsInput()) return
    const chord = typed.length === 1 && (key.ctrl || key.meta)
      ? `${key.ctrl ? 'ctrl' : 'alt'}${key.shift ? '+shift' : ''}+${typed.toLowerCase()}`
      : undefined
    const preferenceAction = chord === undefined ? undefined : preferences.actionForChord(chord)
    if (interactionSnapshot?.kind === 'approval') {
      if (typed.toLowerCase() === 'y') {
        interaction.answerApproval('allowed-once')
        setNotice('Approved once.')
      } else if (typed.toLowerCase() === 'n' || key.escape || (key.ctrl && typed === 'c')) {
        interaction.answerApproval('rejected')
        setNotice('Approval rejected.')
      }
      return
    }

    if (interactionSnapshot?.kind === 'questions') {
      const question = interactionSnapshot.questions[questionIndex]
      if (question === undefined) return
      const options = question.options ?? []
      if (key.ctrl && typed === 'c') {
        input.cancelAgent()
        setNotice('Agent cancellation requested.')
        return
      }
      if (customMode) {
        if (key.escape || key.tab) {
          setCustomMode(false)
          return
        }
        if (key.backspace || key.delete) {
          setCustomText(removeLastCharacter)
          return
        }
        if (key.return) {
          if (customText.trim() === '') {
            setNotice('Other answer must not be empty.')
            return
          }
          finishQuestion(question, {
            custom: customText,
            id: question.id,
            selected: question.multiSelect === true ? [...selected] : [],
          })
          return
        }
        if (!key.ctrl && !key.meta) setCustomText(value => appendTypedText(value, typed))
        return
      }
      if (key.tab || options.length === 0) {
        setCustomMode(true)
        return
      }
      if (key.upArrow) {
        setCursor(index => Math.max(0, index - 1))
        return
      }
      if (key.downArrow) {
        setCursor(index => Math.min(options.length - 1, index + 1))
        return
      }
      if (typed === ' ' && question.multiSelect === true) {
        const label = options[cursor]?.label
        if (label === undefined) return
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(label)) next.delete(label)
          else next.add(label)
          return next
        })
        return
      }
      if (key.return) {
        const answers = question.multiSelect === true
          ? [...selected]
          : options[cursor] === undefined ? [] : [options[cursor].label]
        if (answers.length === 0) {
          setNotice('Select at least one option or press Tab for Other.')
          return
        }
        finishQuestion(question, { id: question.id, selected: answers })
      }
      return
    }

    if (preferenceAction === 'command.palette') {
      if (overlay.getSnapshot().active === 'command-palette') {
        overlay.close('command-palette')
        setNotice('Command palette closed.')
      } else {
        completion.cancel()
        palette.reset()
        overlay.open('command-palette')
        setNotice('Command palette opened.')
      }
      return
    }

    if (preferenceAction === 'session.center') {
      if (overlay.getSnapshot().active === 'session-center') {
        overlay.close('session-center')
        setNotice('Session center closed.')
      } else {
        completion.cancel()
        sessionCenter.resetQuery()
        sessionCenter.refresh()
        overlay.open('session-center')
        setNotice('Session center opened.')
      }
      return
    }

    if (
      preferenceAction === 'activity.center'
      || preferenceAction === 'jobs.center'
      || preferenceAction === 'projection.center'
      || preferenceAction === 'subagent.center'
    ) {
      const kind = preferenceAction === 'activity.center'
        ? 'activity'
        : preferenceAction === 'jobs.center'
          ? 'jobs'
          : preferenceAction === 'projection.center' ? 'projections' : 'subagents'
      if (overlay.getSnapshot().active === kind) {
        overlay.close(kind)
        setNotice('Overlay closed.')
      } else {
        completion.cancel()
        if (kind === 'activity') activity.refresh()
        else if (kind === 'jobs') jobs.refresh()
        else if (kind === 'projections') projections.refresh()
        else void subagents.refresh()
        overlay.open(kind)
        setNotice(`Opened ${kind}.`)
      }
      return
    }

    const inputSurface = resolveInputSurface(overlay.getSnapshot(), {
      interactionActive: false,
      searchOpen: viewport.getSnapshot().search.open,
    })
    if (inputSurface === 'overlay') {
      const activeOverlay = overlay.getSnapshot().active
      if (
        activeOverlay === 'permissions'
        && permission.getSnapshot().status === 'confirming'
        && (key.escape || (key.ctrl && typed.toLowerCase() === 'c'))
      ) {
        permission.cancelConfirmation()
        setNotice('Dangerous permission change cancelled.')
        return
      }
      if (
        activeOverlay === 'recovery'
        && (recovery.getSnapshot().status === 'export-input'
          || recovery.getSnapshot().status === 'confirming-fork')
        && (key.escape || (key.ctrl && typed.toLowerCase() === 'c'))
      ) {
        recovery.cancelMode()
        setNotice('Recovery action cancelled.')
        return
      }
      if (
        activeOverlay === 'recovery'
        && recovery.getSnapshot().status === 'running'
        && (key.escape || (key.ctrl && typed.toLowerCase() === 'c'))
      ) {
        recovery.cancelOperation()
        setNotice('Recovery cancellation requested.')
        return
      }
      if (
        activeOverlay === 'subagents'
        && subagents.getSnapshot().status === 'followup-input'
        && (key.escape || (key.ctrl && typed.toLowerCase() === 'c'))
      ) {
        subagents.cancelFollowup()
        setNotice('Subagent follow-up cancelled.')
        return
      }
      if (
        activeOverlay === 'jobs'
        && jobs.getSnapshot().status === 'confirming'
        && (key.escape || (key.ctrl && typed.toLowerCase() === 'c'))
      ) {
        jobs.dismissCancel()
        setNotice('Job cancellation dismissed.')
        return
      }
      if (key.escape || (key.ctrl && typed.toLowerCase() === 'c')) {
        if (activeOverlay === 'completion') completion.cancel()
        overlay.close()
        setNotice('Overlay closed.')
        return
      }
      if (activeOverlay === 'command-palette') {
        if (key.upArrow) palette.move('up')
        else if (key.downArrow || key.tab) palette.move('down')
        else if (key.return) choosePaletteItem(palette.selected())
        else if (key.backspace || key.delete) palette.backspaceQuery()
        else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
          if (palette.insertQuery(typed) === 'limit-exceeded') {
            setNotice('Palette query is too long.')
          }
        }
        return
      }
      if (activeOverlay === 'session-center') {
        if (!key.ctrl && typed.toLowerCase() === 'w') {
          const snapshot = sessionCenter.getSnapshot()
          const roots = snapshot.workspaces.map(group => group.root)
          if (roots.length === 0) setNotice('No session records a workspace.')
          else {
            const current = snapshot.workspaceRoot
            const index = current === undefined ? -1 : roots.indexOf(current)
            // Cycles through each root and back to "all".
            const next = index + 1 >= roots.length ? undefined : roots[index + 1]
            sessionCenter.setWorkspaceRoot(next)
            setNotice(next === undefined
              ? 'Showing sessions from every workspace.'
              : `Showing sessions from ${next}. Resuming does not move this process.`)
          }
          return
        }
        if (key.upArrow) sessionCenter.move('up')
        else if (key.downArrow || key.tab) sessionCenter.move('down')
        else if (typed === ' ') sessionCenter.inspectSelected()
        else if (!key.ctrl && typed.toLowerCase() === 'r') sessionCenter.refresh()
        else if (key.return) {
          if (editor.getSnapshot().text !== '') {
            setNotice('Clear the composer draft before switching sessions.')
          } else if (input.commandPending) {
            setNotice('Cancel the running command before switching sessions.')
          } else if (agentStatus === 'running') {
            setNotice('Wait for or cancel the active agent before switching sessions.')
          } else if (!sessionCenter.resumeSelected()) {
            setNotice('Select a different persisted session to resume.')
          } else {
            setNotice('Switching sessions…')
          }
        } else if (key.backspace || key.delete) sessionCenter.backspaceQuery()
        else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
          if (sessionCenter.insertQuery(typed) === 'limit-exceeded') {
            setNotice('Session filter is too long.')
          }
        }
        return
      }
      if (activeOverlay === 'permissions') {
        if (permission.getSnapshot().status === 'confirming') {
          if (key.return) {
            setNotice(permission.confirm()
              ? 'Permission preset changed.'
              : 'Confirmation did not match; permission unchanged.')
          } else if (key.backspace || key.delete) permission.backspaceConfirmation()
          else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
            if (permission.insertConfirmation(typed) === 'limit-exceeded') {
              setNotice('Permission confirmation is too long.')
            }
          }
        } else if (key.upArrow) permission.move('up')
        else if (key.downArrow || key.tab) permission.move('down')
        else if (key.return) {
          const result = permission.requestSelected()
          setNotice(result === 'applied'
            ? 'Permission preset changed.'
            : result === 'confirmation-required'
              ? 'Type the displayed phrase to enable dangerous access.'
              : result === 'unavailable'
                ? 'Permission preset service is unavailable.'
                : 'Permission preset is already active or could not be changed.')
        }
        return
      }
      if (activeOverlay === 'recovery') {
        const recoveryStatus = recovery.getSnapshot().status
        if (recoveryStatus === 'export-input') {
          if (key.return) recovery.confirm()
          else if (key.backspace || key.delete) recovery.backspaceDestination()
          else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
            if (recovery.insertDestination(typed) === 'limit-exceeded') {
              setNotice('Export destination is too long.')
            }
          }
        } else if (recoveryStatus === 'confirming-fork') {
          if (key.return) recovery.confirm()
        } else if (recoveryStatus !== 'running') {
          if (key.upArrow) recovery.move('up')
          else if (key.downArrow || key.tab) recovery.move('down')
          else if (key.return) {
            const result = recovery.activateSelected()
            if (result === 'unavailable') setNotice('Selected recovery capability is unavailable.')
          }
        }
        return
      }
      if (activeOverlay === 'changes') {
        if (key.upArrow) changes.move('up')
        else if (key.downArrow || key.tab) changes.move('down')
        else if (key.return) changes.toggleSelected()
        else if (!key.ctrl && typed.toLowerCase() === 'j') {
          const selectedChange = changes.selected()
          if (selectedChange === undefined) {
            setNotice('No change is selected.')
          } else if (viewport.focusRow(selectedChange.rowId)) {
            overlay.close('changes')
            setNotice(`Jumped to ${selectedChange.path}.`)
          } else {
            setNotice('The linked transcript row is outside the retained window.')
          }
        }
        return
      }
      if (activeOverlay === 'plugins') {
        if (key.upArrow) plugins.move('up')
        else if (key.downArrow || key.tab) plugins.move('down')
        else if (!key.ctrl && typed.toLowerCase() === 'r') {
          setNotice(plugins.refresh()
            ? 'Plugin inventory refreshed.'
            : 'No plugin inventory is mounted on this Harness baseline.')
        }
        return
      }
      if (activeOverlay === 'mcp') {
        if (key.upArrow) mcp.move('up')
        else if (key.downArrow || key.tab) mcp.move('down')
        else if (!key.ctrl && typed.toLowerCase() === 'r') {
          setNotice(mcp.refresh() ? 'MCP inventory refreshed.' : 'The tool registry is unavailable.')
        }
        return
      }
      if (activeOverlay === 'skills') {
        if (key.upArrow) skills.move('up')
        else if (key.downArrow) skills.move('down')
        else if (key.ctrl && typed.toLowerCase() === 'd') {
          void skills.inspect().then((ok) => {
            setNotice(ok ? 'Skill body loaded.' : 'That skill could not be loaded.')
          })
        } else if (key.return) {
          const invocation = skills.invocationFor()
          if (invocation === undefined) {
            setNotice('That skill is not user-invocable.')
          } else if (editor.insert(invocation) === 'limit-exceeded') {
            setNotice('Composer is full.')
          } else {
            overlay.close('skills')
            setNotice('Skill invocation inserted; press Enter to run it.')
          }
        } else if (key.backspace || key.delete) {
          skills.setQuery(removeLastCharacter(skills.getSnapshot().query))
        } else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
          skills.setQuery(skills.getSnapshot().query + typed)
        }
        return
      }
      if (activeOverlay === 'attachments') {
        if (key.return) {
          if (readFile === undefined) setNotice('Attaching files is unavailable here.')
          else {
            void attachments.attachDraft(readFile).then((outcome) => {
              setNotice(outcome === 'attached'
                ? 'Image attached.'
                : outcome === 'unavailable'
                  ? 'No attachment store on this Harness baseline.'
                  : 'That file was refused; see the panel for why.')
            })
          }
        } else if (key.ctrl && typed.toLowerCase() === 'd') {
          const last = attachments.getSnapshot().rows.at(-1)
          setNotice(last !== undefined && attachments.remove(last.attachmentId)
            ? 'Dropped the last attachment.'
            : 'Nothing staged.')
        } else if (key.ctrl && typed.toLowerCase() === 'x') {
          setNotice(attachments.clear() ? 'Attachments cleared.' : 'Nothing staged.')
        } else if (key.backspace || key.delete) {
          attachments.setDraftPath(removeLastCharacter(attachments.getSnapshot().draftPath))
        } else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
          attachments.setDraftPath(attachments.getSnapshot().draftPath + typed)
        }
        return
      }
      if (activeOverlay === 'activity') {
        if (key.upArrow) activity.move('up')
        else if (key.downArrow || key.tab) activity.move('down')
        else if (key.return) {
          const target = activity.selectedTarget()
          if (target === undefined) setNotice('Nothing pending.')
          else {
            // Opening the answering panel is what acknowledges the notification.
            activity.acknowledgeSelected()
            if (target === 'jobs') jobs.refresh()
            else if (target === 'subagents') void subagents.refresh()
            else if (target === 'projections') projections.refresh()
            overlay.open(target)
            setNotice(`Opened ${target}.`)
          }
        } else if (!key.ctrl && typed.toLowerCase() === 'd') {
          setNotice(activity.acknowledgeSelected() ? 'Notification dismissed.' : 'Nothing pending.')
        } else if (!key.ctrl && typed.toLowerCase() === 'c') {
          setNotice(activity.acknowledgeAll() ? 'All notifications cleared.' : 'Nothing pending.')
        }
        return
      }
      if (activeOverlay === 'subagents') {
        const subagentStatus = subagents.getSnapshot().status
        if (subagentStatus === 'followup-input') {
          if (key.return) {
            void subagents.followup().then((outcome) => {
              setNotice(outcome === 'delivered'
                ? 'Follow-up delivered to the child inbox.'
                : outcome === 'refused'
                  ? 'That child cannot accept a follow-up from this session.'
                  : 'Follow-up delivery failed.')
            })
          } else if (key.backspace || key.delete) {
            const current = subagents.getSnapshot().followupText
            subagents.setFollowupText(removeLastCharacter(current))
          } else if (!key.ctrl && !key.meta && !key.super && typed !== '') {
            subagents.setFollowupText(subagents.getSnapshot().followupText + typed)
          }
          return
        }
        if (key.upArrow) subagents.move('up')
        else if (key.downArrow || key.tab) subagents.move('down')
        else if (!key.ctrl && typed.toLowerCase() === 'f') {
          setNotice(subagents.beginFollowup()
            ? 'Type a follow-up, then Enter.'
            : 'Only a direct continuable child can be followed up from this session.')
        } else if (!key.ctrl && typed.toLowerCase() === 'i') {
          setNotice(subagents.interrupt()
            ? 'Interrupt signalled; the child stops when it observes it.'
            : 'Only a live continuable child can be interrupted.')
        } else if (!key.ctrl && typed.toLowerCase() === 'a') {
          setNotice(subagents.attach()
            ? 'Attaching to the selected child session.'
            : 'That row has no attachable child session.')
        } else if (!key.ctrl && typed.toLowerCase() === 'm') {
          setNotice(subagents.acknowledge() ? 'Subagent updates marked read.' : 'Nothing unread.')
        } else if (!key.ctrl && typed.toLowerCase() === 'r') {
          void subagents.refresh().then((ok) => {
            setNotice(ok ? 'Subagent tree refreshed.' : 'The subagent runtime is unavailable.')
          })
        }
        return
      }
      if (activeOverlay === 'jobs') {
        if (jobs.getSnapshot().status === 'confirming') {
          if (key.return) {
            const outcome = jobs.confirmCancel()
            setNotice(outcome === 'requested'
              ? 'Job cancellation requested.'
              : outcome === 'already-finished'
                ? 'That job had already finished.'
                : 'Job cancellation failed.')
          }
          return
        }
        if (key.upArrow) jobs.move('up')
        else if (key.downArrow || key.tab) jobs.move('down')
        else if (!key.ctrl && typed.toLowerCase() === 'k') {
          setNotice(jobs.requestCancel()
            ? 'Confirm cancellation with Enter.'
            : 'Only a live job owned by this session can be cancelled.')
        } else if (!key.ctrl && typed.toLowerCase() === 'a') {
          setNotice(jobs.acknowledgeNotices()
            ? 'Completion notices acknowledged.'
            : 'No completion notices to acknowledge.')
        } else if (!key.ctrl && typed.toLowerCase() === 'r') {
          setNotice(jobs.refresh()
            ? 'Job list refreshed.'
            : 'The job registry is unavailable or refresh failed.')
        }
        return
      }
      if (activeOverlay === 'projections') {
        if (key.upArrow) projections.move('up')
        else if (key.downArrow || key.tab) projections.move('down')
        else if (!key.ctrl && typed.toLowerCase() === 'r') {
          setNotice(projections.refresh()
            ? 'Projection snapshot refreshed.'
            : 'Projection registry is unavailable or refresh failed.')
        }
        return
      }
      if (key.upArrow) {
        completion.move('up')
        return
      }
      if (key.downArrow || key.tab) {
        completion.move('down')
        return
      }
      if (key.return) {
        applySelectedCompletion()
        return
      }
      completion.cancel()
      overlay.close('completion')
      if (key.backspace) editor.backspace()
      else if (key.delete) editor.deleteForward()
      else if (!key.ctrl && !key.meta && !key.super && typed !== '') editor.insert(typed)
      return
    }

    if (viewport.getSnapshot().search.open) {
      if (key.escape || (key.ctrl && typed === 'c')) {
        viewport.closeSearch()
        setNotice('Transcript search closed.')
        return
      }
      if (key.return || key.downArrow || (key.ctrl && typed.toLowerCase() === 'f')) {
        viewport.nextMatch(key.shift ? 'previous' : 'next')
        return
      }
      if (key.upArrow) {
        viewport.nextMatch('previous')
        return
      }
      if (key.backspace || key.delete) {
        viewport.backspaceSearch()
        return
      }
      if (!key.ctrl && !key.meta && !key.super && typed !== '') {
        if (viewport.insertSearch(typed) === 'limit-exceeded') {
          setNotice('Search query is too long.')
        }
      }
      return
    }

    if (preferenceAction === 'transcript.search') {
      viewport.openSearch()
      setNotice('Transcript search opened.')
      return
    }
    if (key.ctrl && (key.upArrow || key.downArrow)) {
      viewport.scrollLines(key.upArrow ? 1 : -1)
      return
    }
    if (key.pageUp || key.pageDown) {
      if (key.meta) {
        if (!viewport.scrollFocusedTool(
          key.pageUp ? 'up' : 'down',
          Math.max(1, Math.floor(dimensions.rows / 2)),
        )) {
          setNotice('Focused tool has no more detail in that direction.')
        }
        return
      }
      viewport.scrollPage(
        key.pageUp ? 'up' : 'down',
        Math.max(1, Math.floor(dimensions.rows / 2)),
      )
      return
    }
    if (key.ctrl && key.home) {
      viewport.toStart()
      return
    }
    if (key.ctrl && key.end) {
      viewport.toEnd()
      return
    }
    if (key.ctrl && typed.toLowerCase() === 'e') {
      const focused = viewport.getSnapshot().focusedRowId
      if (focused === undefined) setNotice('No focused row to expand.')
      else {
        setExpandedRowIds((current) => {
          const next = new Set(current)
          if (next.has(focused)) next.delete(focused)
          else next.add(focused)
          return next
        })
      }
      return
    }
    if (key.ctrl && typed.toLowerCase() === 't') {
      if (key.shift) viewport.toggleCompactTools()
      else if (!viewport.toggleFocusedTool()) setNotice('No focused tool details to fold.')
      return
    }
    if (key.ctrl && key.shift && typed.toLowerCase() === 'c') {
      copyVisibleTranscript()
      return
    }

    if (key.ctrl && typed === 'q') {
      onQuit(0)
      return
    }

    if (key.escape) {
      if (editor.clearSelection()) {
        setNotice('Selection cleared.')
      } else if (editor.getSnapshot().text !== '') {
        editor.clear()
        setNotice('Composer cleared.')
      } else if (agentStatus === 'running') {
        input.cancelAgent()
        setNotice('Agent cancellation requested.')
      } else {
        onQuit(0)
      }
      return
    }

    if (key.ctrl && typed === 'c') {
      if (input.commandPending) {
        input.cancelCommand()
        setNotice('Command cancellation requested.')
      } else if (editor.getSnapshot().text !== '') {
        editor.clear()
        setNotice('Composer cleared.')
      } else if (agentStatus === 'running') {
        input.cancelAgent()
        setNotice('Agent cancellation requested.')
      } else {
        onQuit(0)
      }
      return
    }
    if (typed === '\u0004') {
      if (editor.getSnapshot().text !== '') editor.deleteForward()
      else if (agentStatus === 'idle') onQuit(0)
      return
    }
    if (key.ctrl && typed === 's') {
      void submitComposer('steer').catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (key.return && (key.ctrl || key.meta)) {
      if (editor.insert('\n') === 'limit-exceeded') {
        setNotice(`Composer exceeds ${String(editor.textLimit)} code units.`)
      }
      return
    }
    if (key.return) {
      void submitComposer('followup').catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (key.backspace || key.delete) {
      if (key.delete) editor.deleteForward()
      else editor.backspace()
      return
    }
    if (key.leftArrow) {
      editor.move(key.meta ? 'word-left' : 'left', key.shift)
      return
    }
    if (key.rightArrow) {
      editor.move(key.meta ? 'word-right' : 'right', key.shift)
      return
    }
    if (key.upArrow) {
      if (!editor.move('up', key.shift) && !key.shift) editor.previousHistory()
      return
    }
    if (key.downArrow) {
      if (!editor.move('down', key.shift) && !key.shift) editor.nextHistory()
      return
    }
    if (key.home) {
      editor.move(key.ctrl ? 'document-start' : 'line-start', key.shift)
      return
    }
    if (key.end) {
      editor.move(key.ctrl ? 'document-end' : 'line-end', key.shift)
      return
    }
    if ((key.super || key.ctrl) && typed.toLowerCase() === 'a') {
      if (key.super) editor.selectAll()
      else editor.move('line-start', key.shift)
      return
    }
    if (key.ctrl && typed.toLowerCase() === 'e') {
      editor.move('line-end', key.shift)
      return
    }
    if (key.ctrl && typed.toLowerCase() === 'b') {
      editor.move('left', key.shift)
      return
    }
    if (key.ctrl && typed.toLowerCase() === 'k') {
      editor.killToLineEnd()
      return
    }
    if (key.ctrl && typed.toLowerCase() === 'w') {
      editor.deleteWordBackward()
      return
    }
    if (key.ctrl && typed.toLowerCase() === 'y') {
      if (editor.yank() === 'limit-exceeded') {
        setNotice(`Composer exceeds ${String(editor.textLimit)} code units.`)
      }
      return
    }
    if ((key.ctrl || key.super) && typed.toLowerCase() === 'z') {
      if (key.shift) editor.redo()
      else editor.undo()
      return
    }
    if (key.tab) {
      const current = editor.getSnapshot()
      if (completion.request(current.text, current.cursor)) {
        overlay.open('completion')
        setNotice('Completion opened.')
      } else if (editor.insert('\t') === 'limit-exceeded') {
        setNotice(`Composer exceeds ${String(editor.textLimit)} code units.`)
      }
      return
    }
    if (!key.ctrl && !key.meta && !key.super && typed !== '') {
      if (editor.insert(typed) === 'limit-exceeded') {
        setNotice(`Composer exceeds ${String(editor.textLimit)} code units.`)
      }
    }
  })

  const composerMaxRows = Math.max(1, Math.min(6, Math.floor(dimensions.rows / 3)))
  const composerView = createComposerView(
    editorSnapshot,
    Math.max(1, dimensions.columns - 2),
    composerMaxRows,
  )
  const composerRows = composerView.rows.length
    + (composerView.hiddenAbove > 0 || composerView.hiddenBelow > 0 ? 1 : 0)
  const activeOverlay = modal === undefined ? overlaySnapshot.active : undefined
  const fullScreenOverlay = activeOverlay !== undefined
    && (dimensions.columns < 60 || dimensions.rows < 16)
  const overlayMaxRows = activeOverlay === undefined
      ? 0
      : fullScreenOverlay
      ? Math.max(4, dimensions.rows)
      : Math.max(6, Math.min(10, Math.floor(dimensions.rows / 2)))
  const searchRows = viewportSnapshot.search.open && activeOverlay === undefined ? 1 : 0
  const screenRows = Math.max(
    4,
    dimensions.rows
      - (fullScreenOverlay ? 0 : composerRows)
      - searchRows
      - overlayMaxRows
      - 1,
  )
  const maximumToolDetailLines = Math.max(
    1,
    screenRows - 5 - (modal === undefined ? 0 : modalRows(modal)),
  )
  const projectedRows = viewport.projectRows(transcriptSnapshot.rows, {
    maxToolDetailLines: maximumToolDetailLines,
  })
  const screen = createScreenModel(
    projectedRows,
    {
      activityCount: activitySnapshot.totalActivity,
      working: workingStatus({
        elapsedMs: turnStartedAt === undefined ? 0 : now - turnStartedAt,
        ...(projectionSnapshot.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: projectionSnapshot.usage.outputTokens }),
        running: agentStatus === 'running',
      }).segments,
      ...(projectionSnapshot.usage?.totalTokens === undefined
        ? {}
        : { contextUsed: projectionSnapshot.usage.totalTokens }),
      // Only what is genuinely loaded; describeSources drops the zeroes.
      contextSources: [
        { count: mcpSnapshot.servers.length, label: 'MCP server' },
        { count: skillSnapshot.totalMatches, label: 'skill' },
      ],
      firstScreen: projectedRows.length === 0,
      welcome: {
        cwd: workspace,
        screenReader: preferenceSnapshot.screenReader,
        theme: preferenceSnapshot.theme,
        version: TUI_VERSION,
      },
      droppedRows: transcriptSnapshot.droppedRows,
      ...(viewportSnapshot.focusedRowId === undefined
        ? {}
        : { focusedRowId: viewportSnapshot.focusedRowId }),
      ...(modal === undefined ? {} : { modalRows: modalRows(modal) }),
      modelLabel: runtimeStatusSnapshot.model ?? modelLabel,
      ...(runtimeStatusSnapshot.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: runtimeStatusSnapshot.approvalPolicy }),
      ...(projectionSnapshot.usage?.contextWindow === undefined
        ? {}
        : { contextWindow: projectionSnapshot.usage.contextWindow }),
      ...(runtimeStatusSnapshot.permissionPreset === undefined
        ? {}
        : { permissionPreset: runtimeStatusSnapshot.permissionPreset }),
      sessionId,
      scrollOffset: viewportSnapshot.scrollOffset,
      status: agentStatus === 'running' ? 'busy' : 'idle',
      terminalRows: screenRows,
      ...(projectionSnapshot.usage?.totalTokens === undefined
        ? {}
        : { totalTokens: projectionSnapshot.usage.totalTokens }),
      unseenRows: viewportSnapshot.unseenRows,
      workspace,
    },
    modal,
  )

  if (fullScreenOverlay && activeOverlay !== undefined) {
    return <OverlayPanel
      active={activeOverlay}
      changes={changeSnapshot}
      columns={dimensions.columns}
      completion={completionSnapshot}
      maxRows={overlayMaxRows}
      palette={paletteSnapshot}
      permissions={permissionSnapshot}
      activity={activitySnapshot}
      attachments={attachmentSnapshot}
      {...(terminalCapabilities === undefined ? {} : { terminalCapabilities })}
      jobs={jobsSnapshot}
      mcp={mcpSnapshot}
      plugins={pluginSnapshot}
      projections={projectionSnapshot}
      skills={skillSnapshot}
      subagents={subagentSnapshot}
      screenReader={preferenceSnapshot.screenReader}
      theme={preferenceSnapshot.theme}
      recovery={recoverySnapshot}
      sessions={sessionCenterSnapshot}
    />
  }

  return (
    <Box flexDirection="column">
      <Frame columns={dimensions.columns} expandedRowIds={expandedRowIds} model={screen} />
      {activeOverlay === undefined ? null : (
        <OverlayPanel
          active={activeOverlay}
          changes={changeSnapshot}
          columns={dimensions.columns}
          completion={completionSnapshot}
          maxRows={overlayMaxRows}
          palette={paletteSnapshot}
          permissions={permissionSnapshot}
          activity={activitySnapshot}
          attachments={attachmentSnapshot}
          {...(terminalCapabilities === undefined ? {} : { terminalCapabilities })}
          jobs={jobsSnapshot}
          mcp={mcpSnapshot}
          plugins={pluginSnapshot}
          projections={projectionSnapshot}
          skills={skillSnapshot}
          subagents={subagentSnapshot}
          screenReader={preferenceSnapshot.screenReader}
          theme={preferenceSnapshot.theme}
          recovery={recoverySnapshot}
          sessions={sessionCenterSnapshot}
        />
      )}
      {viewportSnapshot.search.open && activeOverlay === undefined ? (
        <Text wrap="truncate-end">
          / {viewportSnapshot.search.query}<Text inverse>█</Text>
          <Text dimColor> · {searchStatus(viewportSnapshot.search)}</Text>
        </Text>
      ) : null}
      <Composer
        columns={dimensions.columns}
        maxRows={composerMaxRows}
        placeholder={COMPOSER_PLACEHOLDER}
        screenReader={preferenceSnapshot.screenReader}
        snapshot={editorSnapshot}
      />
      <Text dimColor wrap="truncate-end">{notice}</Text>
    </Box>
  )
}
