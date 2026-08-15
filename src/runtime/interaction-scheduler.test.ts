import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'

import { InteractionScheduler, type InteractionHost } from './interaction-scheduler'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function fakeAgent(ctx = new Context(), id = 'root'): Agent {
  return { ctx, id, status: 'idle' } as unknown as Agent
}

function questionRequest(
  agent?: Agent,
  signal?: AbortSignal,
): AskUserQuestionRequest {
  return {
    ...(agent === undefined ? {} : { agent }),
    questions: [{
      header: 'Choice',
      id: 'choice',
      options: [
        { description: 'Continue now', label: 'Yes' },
        { label: 'No' },
      ],
      question: 'Continue?',
    }],
    ...(signal === undefined ? {} : { signal }),
  }
}

function mount(
  host: InteractionHost,
  options: { readonly agent?: Agent; readonly maximum?: number } = {},
) {
  const agent = options.agent ?? fakeAgent()
  let provider: UserQuestionProvider | undefined
  const unregister = vi.fn()
  const registerProvider = vi.fn((next: UserQuestionProvider) => {
    provider = next
    return unregister
  })
  const scheduler = new InteractionScheduler({
    agent,
    host,
    ...(options.maximum === undefined ? {} : { maxPendingInteractions: options.maximum }),
    userQuestions: { registerProvider },
  })
  return {
    agent,
    ask: (request: AskUserQuestionRequest) => {
      if (provider === undefined) throw new Error('provider not mounted')
      return provider.ask(request)
    },
    registerProvider,
    scheduler,
    unregister,
  }
}

function host(overrides: Partial<InteractionHost> = {}): InteractionHost {
  return {
    askApproval: async () => 'rejected',
    askQuestions: async request => ({
      answers: request.questions.map(question => ({ id: question.id, selected: ['Yes'] })),
    }),
    ...overrides,
  }
}

async function requestApproval(
  agent: Agent,
  request: ApprovalRequest,
  fallback: ApprovalOutcome = 'unavailable',
): Promise<ApprovalOutcome> {
  return agent.ctx.waterfall(
    'approval/request',
    request,
    () => Promise.resolve(fallback),
  )
}

describe('InteractionScheduler', () => {
  it('answers approvals only for the exact attached agent', async () => {
    const askApproval = vi.fn(async () => 'allowed-once' as const)
    const mounted = mount(host({ askApproval }))
    const ownRequest = { agent: mounted.agent, reason: 'needed', toolName: 'bash' }
    const foreignAgent = fakeAgent(mounted.agent.ctx, 'foreign')

    await expect(requestApproval(mounted.agent, ownRequest)).resolves.toBe('allowed-once')
    await expect(requestApproval(mounted.agent, {
      agent: foreignAgent,
      toolName: 'bash',
    }, 'rejected')).resolves.toBe('rejected')
    expect(askApproval).toHaveBeenCalledOnce()
    await mounted.scheduler.dispose()
  })

  it('fails approval closed on host errors or invalid outcomes and honors abort', async () => {
    const abort = new AbortController()
    const askApproval = vi.fn(async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
      if (request.toolName === 'throw') throw new Error('terminal failed')
      return 'unavailable'
    })
    const mounted = mount(host({ askApproval }))

    await expect(requestApproval(mounted.agent, {
      agent: mounted.agent,
      toolName: 'throw',
    })).resolves.toBe('unavailable')
    abort.abort()
    await expect(requestApproval(mounted.agent, {
      agent: mounted.agent,
      signal: abort.signal,
      toolName: 'bash',
    })).resolves.toBe('cancelled')
    await mounted.scheduler.dispose()
  })

  it('validates generic, multi-select, custom, and plan-review answers', async () => {
    const answer: AskUserQuestionAnswer = {
      answers: [
        { id: 'single', selected: ['A'] },
        { custom: 'extra', id: 'multi', selected: ['X', 'Y'] },
        { id: 'plan', selected: ['Approve'] },
      ],
    }
    const mounted = mount(host({ askQuestions: async () => answer }))
    const request: AskUserQuestionRequest = {
      agent: mounted.agent,
      questions: [
        { id: 'single', options: [{ label: 'A' }], question: 'One?' },
        {
          id: 'multi',
          multiSelect: true,
          options: [{ label: 'X' }, { label: 'Y' }],
          question: 'Many?',
        },
        {
          detail: '# Plan',
          id: 'plan',
          intent: { approve: 'Approve', kind: 'plan-review' },
          options: [{ label: 'Approve' }, { label: 'Revise' }],
          question: 'Review?',
        },
      ],
    }

    await expect(mounted.ask(request)).resolves.toBe(answer)
    await mounted.scheduler.dispose()
  })

  it('refuses questions for another agent and malformed provider answers', async () => {
    const mounted = mount(host({
      askQuestions: async () => ({ answers: [{ id: 'choice', selected: ['Unknown'] }] }),
    }))

    await expect(mounted.ask(questionRequest(fakeAgent()))).rejects.toMatchObject({
      code: 'WRONG_AGENT',
    })
    await expect(mounted.ask(questionRequest(mounted.agent))).rejects.toMatchObject({
      code: 'INVALID_ANSWER',
    })
    await mounted.scheduler.dispose()
  })

  it('serializes modal ownership and aborts a queued question promptly', async () => {
    const first = deferred<ApprovalOutcome>()
    const askQuestions = vi.fn(async () => ({
      answers: [{ id: 'choice', selected: ['Yes'] }],
    }))
    const mounted = mount(host({
      askApproval: () => first.promise,
      askQuestions,
    }))
    const approval = requestApproval(mounted.agent, {
      agent: mounted.agent,
      toolName: 'slow',
    })
    const abort = new AbortController()
    const question = mounted.ask(questionRequest(mounted.agent, abort.signal))

    expect(askQuestions).not.toHaveBeenCalled()
    abort.abort()
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(askQuestions).not.toHaveBeenCalled()
    first.resolve('rejected')
    await expect(approval).resolves.toBe('rejected')
    await mounted.scheduler.dispose()
  })

  it('bounds pending modal work', async () => {
    const first = deferred<ApprovalOutcome>()
    const mounted = mount(host({ askApproval: () => first.promise }), { maximum: 1 })
    const approval = requestApproval(mounted.agent, {
      agent: mounted.agent,
      toolName: 'slow',
    })

    await expect(mounted.ask(questionRequest(mounted.agent)))
      .rejects.toThrow('Too many pending terminal interactions')
    first.resolve('rejected')
    await approval
    await mounted.scheduler.dispose()
  })

  it('unregisters both seams and waits for the active host on disposal', async () => {
    const observedAbort = deferred<undefined>()
    const hostStarted = deferred<undefined>()
    const mounted = mount(host({
      askApproval: (_request, signal) => new Promise<ApprovalOutcome>((resolve) => {
        hostStarted.resolve(undefined)
        signal.addEventListener('abort', () => {
          observedAbort.resolve(undefined)
          resolve('rejected')
        }, { once: true })
      }),
    }))
    const approval = requestApproval(mounted.agent, {
      agent: mounted.agent,
      toolName: 'slow',
    })

    await hostStarted.promise
    const firstDispose = mounted.scheduler.dispose()
    expect(mounted.scheduler.dispose()).toBe(firstDispose)
    await observedAbort.promise
    await firstDispose
    await expect(approval).resolves.toBe('unavailable')
    expect(mounted.unregister).toHaveBeenCalledOnce()
  })

  it('rolls back approval registration when question-provider setup fails', async () => {
    const agent = fakeAgent()
    const askApproval = vi.fn(async () => 'allowed-once' as const)
    expect(() => new InteractionScheduler({
      agent,
      host: host({ askApproval }),
      userQuestions: {
        registerProvider: () => { throw new Error('duplicate provider') },
      },
    })).toThrow('duplicate provider')
    await expect(requestApproval(agent, {
      agent,
      toolName: 'bash',
    }, 'rejected')).resolves.toBe('rejected')
    expect(askApproval).not.toHaveBeenCalled()
  })
})
