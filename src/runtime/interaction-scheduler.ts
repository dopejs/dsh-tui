import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
  type UserQuestionService,
} from '@deepseek-ai/dsh-user-questions'

const DEFAULT_MAX_PENDING_INTERACTIONS = 32
const APPROVAL_ANSWERS = new Set<ApprovalOutcome>(['allowed-once', 'rejected'])

type QuestionRegistrar = Pick<UserQuestionService, 'registerProvider'>

export interface InteractionHost {
  askApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome>
  askQuestions(
    request: AskUserQuestionRequest,
    signal: AbortSignal,
  ): Promise<AskUserQuestionAnswer>
}

export interface InteractionSchedulerOptions {
  readonly agent: Agent
  readonly host: InteractionHost
  readonly maxPendingInteractions?: number
  readonly userQuestions: QuestionRegistrar
}

function validateMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_PENDING_INTERACTIONS
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_024) {
    throw new RangeError('maxPendingInteractions must be a safe integer between 1 and 1024')
  }
  return maximum
}

function abortError(): UserQuestionError {
  return new UserQuestionError(
    'ask_user_question was aborted before the user answered',
    'ASK_ABORTED',
  )
}

function disposedError(): Error {
  return new Error('Interaction scheduler is disposed')
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function validateAnswer(
  request: AskUserQuestionRequest,
  answer: AskUserQuestionAnswer,
): AskUserQuestionAnswer {
  if (answer.answers.length !== request.questions.length) {
    throw new UserQuestionError(
      'user-question provider must answer every question exactly once',
      'INVALID_ANSWER',
    )
  }
  const questions = new Map(request.questions.map(question => [question.id, question]))
  const seen = new Set<string>()
  for (const item of answer.answers) {
    const question = questions.get(item.id)
    if (question === undefined || seen.has(item.id)) {
      throw new UserQuestionError(
        `user-question provider returned an unknown or duplicate id: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
    seen.add(item.id)
    const labels = new Set((question.options ?? []).map(option => option.label))
    if (item.selected.some(label => !labels.has(label))) {
      throw new UserQuestionError(
        `user-question provider returned an unknown option for: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
    if (new Set(item.selected).size !== item.selected.length) {
      throw new UserQuestionError(
        `user-question provider returned a duplicate option for: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
    if (item.custom !== undefined && item.custom.trim() === '') {
      throw new UserQuestionError(
        `user-question provider returned empty custom text for: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
    if (question.multiSelect !== true && item.selected.length > 1) {
      throw new UserQuestionError(
        `user-question provider selected multiple options for single-select: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
    if (
      question.multiSelect !== true
      && item.selected.length > 0
      && item.custom !== undefined
    ) {
      throw new UserQuestionError(
        `user-question provider combined a selection and custom text for: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
    if (item.selected.length === 0 && (item.custom?.trim().length ?? 0) === 0) {
      throw new UserQuestionError(
        `user-question provider returned no answer for: ${item.id}`,
        'INVALID_ANSWER',
      )
    }
  }
  return answer
}

export class InteractionScheduler {
  readonly #agent: Agent
  readonly #host: InteractionHost
  readonly #lifecycleAbort = new AbortController()
  readonly #maxPending: number
  #disposed = false
  #disposing: Promise<void> | undefined
  #pending = 0
  #stopApproval: (() => void) | undefined
  #stopQuestions: (() => void) | undefined
  #tail: Promise<void> = Promise.resolve()

  constructor(options: InteractionSchedulerOptions) {
    this.#agent = options.agent
    this.#host = options.host
    this.#maxPending = validateMaximum(options.maxPendingInteractions)

    this.#stopApproval = options.agent.ctx.on('approval/request', (request, next) => {
      if (request.agent !== this.#agent) return next()
      return this.#approval(request)
    })
    try {
      const provider: UserQuestionProvider = { ask: request => this.#questions(request) }
      this.#stopQuestions = options.userQuestions.registerProvider(provider)
    } catch (error) {
      try {
        this.#stopApproval()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Interaction scheduler setup and rollback both failed',
          { cause: cleanupError },
        )
      }
      this.#stopApproval = undefined
      throw error
    }
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    const failures: unknown[] = []
    try {
      this.#stopQuestions?.()
    } catch (error) {
      failures.push(error)
    }
    this.#stopQuestions = undefined
    try {
      this.#stopApproval?.()
    } catch (error) {
      failures.push(error)
    }
    this.#stopApproval = undefined
    this.#lifecycleAbort.abort(disposedError())
    try {
      await this.#tail
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Interaction scheduler did not dispose cleanly')
    }
  }

  async #approval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (this.#disposed) return 'unavailable'
    const signal = request.signal === undefined
      ? this.#lifecycleAbort.signal
      : AbortSignal.any([request.signal, this.#lifecycleAbort.signal])
    if (signal.aborted) return request.signal?.aborted === true ? 'cancelled' : 'unavailable'
    try {
      const answer = await this.#enqueue(
        () => this.#host.askApproval(request, signal),
        signal,
      )
      return APPROVAL_ANSWERS.has(answer) ? answer : 'unavailable'
    } catch {
      return signal.aborted && request.signal?.aborted === true ? 'cancelled' : 'unavailable'
    }
  }

  async #questions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (this.#disposed) throw disposedError()
    if (request.agent !== undefined && request.agent !== this.#agent) {
      throw new UserQuestionError(
        'TUI user-question provider cannot answer for a different live agent',
        'WRONG_AGENT',
      )
    }
    const signal = request.signal === undefined
      ? this.#lifecycleAbort.signal
      : AbortSignal.any([request.signal, this.#lifecycleAbort.signal])
    if (signal.aborted) throw abortError()
    let answer: AskUserQuestionAnswer
    try {
      answer = await this.#enqueue(
        () => this.#host.askQuestions(request, signal),
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw abortError()
      throw error
    }
    if (signal.aborted) throw abortError()
    return validateAnswer(request, answer)
  }

  #enqueue<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new Error('Too many pending terminal interactions'))
    }
    this.#pending += 1
    const work = this.#tail.then(async () => {
      if (signal.aborted) throw signal.reason
      return operation()
    })
    this.#tail = work.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#pending -= 1
    })
    return raceWithAbort(work, signal)
  }
}
