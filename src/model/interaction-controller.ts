import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionIntent,
  AskUserQuestionOption,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

import type { InteractionHost } from '../runtime/interaction-scheduler'

export interface InteractionQuestion {
  readonly detail?: string
  readonly header?: string
  readonly id: string
  readonly intent?: Readonly<AskUserQuestionIntent>
  readonly multiSelect?: boolean
  readonly options?: readonly Readonly<AskUserQuestionOption>[]
  readonly question: string
}

export type InteractionSnapshot =
  | {
      readonly agentLabel: string
      readonly callId?: string
      readonly kind: 'approval'
      readonly reason?: string
      readonly toolName: string
    }
  | {
      readonly agentLabel: string
      readonly kind: 'questions'
      readonly questions: readonly InteractionQuestion[]
    }
  | undefined

export interface InteractionStore {
  readonly getSnapshot: () => InteractionSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

interface Pending<T> {
  readonly reject: (error: unknown) => void
  readonly resolve: (answer: T) => void
  readonly stopAbort: () => void
}

function copyQuestions(
  questions: AskUserQuestionRequest['questions'],
): readonly InteractionQuestion[] {
  return Object.freeze(questions.map(question => Object.freeze({
    ...question,
    ...(question.intent === undefined ? {} : { intent: Object.freeze({ ...question.intent }) }),
    ...(question.options === undefined
      ? {}
      : { options: Object.freeze(question.options.map(option => Object.freeze({ ...option }))) }),
  })))
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Terminal interaction was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return error
}

export class InteractionController implements InteractionHost, InteractionStore {
  readonly #listeners = new Set<() => void>()
  readonly #reportError: (error: unknown) => void
  #disposed = false
  #pendingApproval: Pending<ApprovalOutcome> | undefined
  #pendingQuestions: Pending<AskUserQuestionAnswer> | undefined
  #snapshot: InteractionSnapshot

  constructor(reportError: (error: unknown) => void = () => undefined) {
    this.#reportError = reportError
  }

  readonly getSnapshot = (): InteractionSnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) throw new Error('Interaction controller is disposed')
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome> {
    if (this.#disposed) return Promise.reject(new Error('Interaction controller is disposed'))
    if (signal.aborted) return Promise.reject(abortReason(signal))
    if (this.#snapshot !== undefined) {
      return Promise.reject(new Error('Terminal interaction host is already occupied'))
    }
    this.#snapshot = Object.freeze({
      agentLabel: String(request.agent.id),
      ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
      kind: 'approval' as const,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      toolName: request.toolName,
    })
    const answer = new Promise<ApprovalOutcome>((resolve, reject) => {
      const onAbort = () => {
        this.#clear()
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#pendingApproval = {
        reject,
        resolve,
        stopAbort: () => signal.removeEventListener('abort', onAbort),
      }
    })
    this.#notify()
    return answer
  }

  askQuestions(
    request: AskUserQuestionRequest,
    signal: AbortSignal,
  ): Promise<AskUserQuestionAnswer> {
    if (this.#disposed) return Promise.reject(new Error('Interaction controller is disposed'))
    if (signal.aborted) return Promise.reject(abortReason(signal))
    if (this.#snapshot !== undefined) {
      return Promise.reject(new Error('Terminal interaction host is already occupied'))
    }
    this.#snapshot = Object.freeze({
      agentLabel: request.agent === undefined ? 'unscoped' : String(request.agent.id),
      kind: 'questions' as const,
      questions: copyQuestions(request.questions),
    })
    const answer = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const onAbort = () => {
        this.#clear()
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#pendingQuestions = {
        reject,
        resolve,
        stopAbort: () => signal.removeEventListener('abort', onAbort),
      }
    })
    this.#notify()
    return answer
  }

  answerApproval(outcome: 'allowed-once' | 'rejected'): void {
    const pending = this.#pendingApproval
    if (pending === undefined) throw new Error('No approval interaction is active')
    pending.stopAbort()
    this.#clear()
    pending.resolve(outcome)
  }

  answerQuestions(answer: AskUserQuestionAnswer): void {
    const pending = this.#pendingQuestions
    if (pending === undefined) throw new Error('No user-question interaction is active')
    pending.stopAbort()
    this.#clear()
    pending.resolve(answer)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const error = new Error('Interaction controller disposed')
    const approval = this.#pendingApproval
    const questions = this.#pendingQuestions
    approval?.stopAbort()
    questions?.stopAbort()
    this.#pendingApproval = undefined
    this.#pendingQuestions = undefined
    this.#snapshot = undefined
    this.#listeners.clear()
    approval?.reject(error)
    questions?.reject(error)
  }

  #clear(): void {
    this.#pendingApproval = undefined
    this.#pendingQuestions = undefined
    this.#snapshot = undefined
    this.#notify()
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        try {
          this.#reportError(error)
        } catch {
          // The interaction must stay usable even when both observer and reporter fail.
        }
      }
    }
  }
}
