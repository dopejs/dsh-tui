import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

import type { AgentStatusStore } from '../model/agent-status-controller'
import type {
  InteractionController,
  InteractionQuestion,
  InteractionSnapshot,
} from '../model/interaction-controller'
import type { TranscriptStore } from '../model/transcript-controller'
import { createScreenModel, type InteractionModal } from '../model/view-model'
import type { InputController, InputSubmission, SubmissionMode } from '../runtime/input-controller'
import { Frame } from './ink-renderer'

interface QuestionDraft {
  readonly custom?: string
  readonly id: string
  readonly selected: readonly string[]
}

export interface InteractiveTuiProps {
  readonly columns?: number
  readonly input: InputController
  readonly interaction: InteractionController
  readonly modelLabel: string
  readonly onQuit: (code: number) => void
  readonly sessionId: string
  readonly status: AgentStatusStore
  readonly terminalRows?: number
  readonly transcript: TranscriptStore
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

export function InteractiveTui({
  columns: fixedColumns,
  input,
  interaction,
  modelLabel,
  onQuit,
  sessionId,
  status,
  terminalRows: fixedRows,
  transcript,
  workspace,
}: InteractiveTuiProps) {
  const { stdout } = useStdout()
  const [dimensions, setDimensions] = useState(() => ({
    columns: fixedColumns ?? stdout.columns ?? 80,
    rows: fixedRows ?? stdout.rows ?? 24,
  }))
  const [composer, setComposer] = useState('')
  const [notice, setNotice] = useState(
    'Enter send · ^S steer · ^C cancel · /exit quit',
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
    const line = composer
    if (line.trim() !== '') setComposer('')
    const submission = await input.submit(line, mode)
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

    if (key.escape) {
      if (composer !== '') {
        setComposer('')
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
      } else if (composer !== '') {
        setComposer('')
        setNotice('Composer cleared.')
      } else if (agentStatus === 'running') {
        input.cancelAgent()
        setNotice('Agent cancellation requested.')
      } else {
        onQuit(0)
      }
      return
    }
    if (typed === '\u0004' && composer === '' && agentStatus === 'idle') {
      onQuit(0)
      return
    }
    if (key.ctrl && typed === 's') {
      void submitComposer('steer').catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (key.return) {
      void submitComposer('followup').catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (key.backspace || key.delete) {
      setComposer(removeLastCharacter)
      return
    }
    if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      setComposer(value => appendTypedText(value, typed))
    }
  })

  const screenRows = Math.max(4, dimensions.rows - 2)
  const screen = createScreenModel(
    transcriptSnapshot.rows,
    {
      ...(modal === undefined ? {} : { modalRows: modalRows(modal) }),
      modelLabel,
      sessionId,
      status: agentStatus === 'running' ? 'busy' : 'idle',
      terminalRows: screenRows,
      workspace,
    },
    modal,
  )

  return (
    <Box flexDirection="column">
      <Frame columns={dimensions.columns} model={screen} />
      <Text wrap="truncate-end">› {composer}<Text inverse> </Text></Text>
      <Text dimColor wrap="truncate-end">{notice}</Text>
    </Box>
  )
}
