import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, usePaste, useStdout } from 'ink'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

import type { AgentStatusStore } from '../model/agent-status-controller'
import type { EditorController } from '../model/editor-controller'
import type {
  InteractionController,
  InteractionQuestion,
  InteractionSnapshot,
} from '../model/interaction-controller'
import type { TranscriptStore } from '../model/transcript-controller'
import type {
  TranscriptViewportController,
  TranscriptViewportSnapshot,
} from '../model/transcript-viewport-controller'
import { projectTranscriptPlainText } from '../model/transcript-viewport-controller'
import { createScreenModel, type InteractionModal } from '../model/view-model'
import type { InputController, InputSubmission, SubmissionMode } from '../runtime/input-controller'
import { Composer, createComposerView } from './composer'
import { writeOsc52Clipboard } from './clipboard'
import { Frame } from './ink-renderer'

interface QuestionDraft {
  readonly custom?: string
  readonly id: string
  readonly selected: readonly string[]
}

export interface InteractiveTuiProps {
  readonly columns?: number
  readonly editor: EditorController
  readonly input: InputController
  readonly interaction: InteractionController
  readonly modelLabel: string
  readonly onQuit: (code: number) => void
  readonly sessionId: string
  readonly status: AgentStatusStore
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
    case 'message':
      return submission.mode === 'steer' ? 'Steering queued.' : 'Message queued.'
    case 'command':
      return submission.execution.result.text
        ?? (submission.execution.result.kind === 'success' ? 'Command completed.' : 'Command failed.')
    case 'command-cancelled':
      return 'Command cancelled.'
    case 'command-error':
    case 'rejected':
      return submission.message
  }
}

function approvalModal(snapshot: Exclude<InteractionSnapshot, undefined> & { kind: 'approval' }) {
  return {
    agentLabel: snapshot.agentLabel,
    message: [
      snapshot.toolName,
      snapshot.reason,
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
  columns: fixedColumns,
  editor,
  input,
  interaction,
  modelLabel,
  onQuit,
  sessionId,
  status,
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
    'Enter send · ^J newline · ^S steer · ^C cancel',
  )
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
      ? approvalModal(interactionSnapshot)
      : questionModal(
          interactionSnapshot,
          questionIndex,
          cursor,
          selected,
          customMode,
          customText,
        )
  }, [cursor, customMode, customText, interactionSnapshot, questionIndex, selected])

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

  usePaste((pasted) => {
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
    if (key.ctrl && typed === 'q') {
      onQuit(0)
      return
    }
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

    if (key.ctrl && typed.toLowerCase() === 'f') {
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
    if (key.ctrl && typed.toLowerCase() === 't') {
      if (key.shift) viewport.toggleCompactTools()
      else if (!viewport.toggleFocusedTool()) setNotice('No focused tool details to fold.')
      return
    }
    if (key.ctrl && key.shift && typed.toLowerCase() === 'c') {
      const plain = projectTranscriptPlainText(screen.rows, 100_000)
      const result = writeOsc52Clipboard(stdout, plain.text)
      setNotice(result === 'sent'
        ? `Visible transcript copied${plain.truncated ? ' with truncation' : ''}.`
        : result === 'too-large'
          ? 'Visible transcript is too large for terminal clipboard transfer.'
          : 'Terminal clipboard transfer is unavailable.')
      return
    }

    if (key.escape) {
      if (editor.clearSelection()) {
        setNotice('Selection cleared.')
      } else if (editorSnapshot.text !== '') {
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
      } else if (editorSnapshot.text !== '') {
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
      if (editorSnapshot.text !== '') editor.deleteForward()
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
      if (editor.insert('\t') === 'limit-exceeded') {
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
  const searchRows = viewportSnapshot.search.open ? 1 : 0
  const screenRows = Math.max(4, dimensions.rows - composerRows - searchRows - 1)
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
      droppedRows: transcriptSnapshot.droppedRows,
      ...(viewportSnapshot.focusedRowId === undefined
        ? {}
        : { focusedRowId: viewportSnapshot.focusedRowId }),
      ...(modal === undefined ? {} : { modalRows: modalRows(modal) }),
      modelLabel,
      sessionId,
      scrollOffset: viewportSnapshot.scrollOffset,
      status: agentStatus === 'running' ? 'busy' : 'idle',
      terminalRows: screenRows,
      unseenRows: viewportSnapshot.unseenRows,
      workspace,
    },
    modal,
  )

  return (
    <Box flexDirection="column">
      <Frame columns={dimensions.columns} model={screen} />
      {viewportSnapshot.search.open ? (
        <Text wrap="truncate-end">
          / {viewportSnapshot.search.query}<Text inverse>█</Text>
          <Text dimColor> · {searchStatus(viewportSnapshot.search)}</Text>
        </Text>
      ) : null}
      <Composer
        columns={dimensions.columns}
        maxRows={composerMaxRows}
        snapshot={editorSnapshot}
      />
      <Text dimColor wrap="truncate-end">{notice}</Text>
    </Box>
  )
}
