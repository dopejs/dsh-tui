import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'

import {
  startTuiRuntime,
  type RuntimeDependencies,
} from './index'
import type { InkApplicationOptions, MountedInkApplication } from './ui/ink-app-runtime'

interface RuntimeFixture {
  readonly agent: Agent
  readonly create: ReturnType<typeof vi.fn>
  readonly ctx: Context
  readonly disposeHandle: ReturnType<typeof vi.fn>
  readonly exits: number[]
  readonly flush: ReturnType<typeof vi.fn>
  readonly mounted: InkApplicationOptions[]
  readonly order: string[]
  readonly questionProvider: () => UserQuestionProvider | undefined
  readonly resume: ReturnType<typeof vi.fn>
  readonly session: FixtureSession
  readonly unregisterQuestions: ReturnType<typeof vi.fn>
}

class FixtureSession {
  readonly #ctx: Context
  readonly #events: SessionEvent[] = []
  readonly header = { cwd: '/fixture/workspace', id: 'live-session' }
  readonly id = 'live-session'

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  get events(): readonly SessionEvent[] {
    return Object.freeze([...this.#events])
  }

  get seq(): number {
    return this.#events.length
  }

  append(event: SessionEvent): void {
    this.#events.push(event)
    this.#ctx.emit('session/event', this as unknown as Session, event)
  }
}

function runtimeFixture(): RuntimeFixture {
  const ctx = new Context()
  const agentCtx = new Context()
  const session = new FixtureSession(agentCtx)
  const agent = {
    cancel: vi.fn(),
    ctx: agentCtx,
    followup: vi.fn(),
    id: 'live-session',
    options: { model: 'fixture-model', provider: 'fixture-provider' },
    session: session as unknown as Session,
    status: 'idle',
    steer: vi.fn(),
  } as unknown as Agent
  const order: string[] = []
  const disposeHandle = vi.fn(async () => {
    order.push('handle')
    await agentCtx.fiber.dispose()
  })
  const handle: AgentHandle = { agent, dispose: disposeHandle }
  const create = vi.fn(async (options: CreateAgentOptions) => {
    await options.setup?.(agentCtx)
    return handle
  })
  const resume = vi.fn(async (options: ResumeAgentOptions) => {
    await options.setup?.(agentCtx)
    return handle
  })
  const flush = vi.fn(async () => {
    order.push('flush')
    return true
  })
  const unregisterQuestions = vi.fn()
  const unregisterCommand = vi.fn()
  ctx.provide('agents', { create, resume } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ model: 'fixture-model', provider: 'fixture-provider' }),
  } as never)
  ctx.provide('commands', { execute: vi.fn(), register: vi.fn(() => unregisterCommand) } as never)
  ctx.provide('sessions', { flush } as never)
  ctx.provide('tools', {
    get: vi.fn(() => ({
      presentCall: () => ({ card: 'terminal', title: 'echo composed' }),
      presentResult: () => ({ card: 'terminal', exitCode: 0, output: 'composed' }),
    })),
  } as never)
  let questionProvider: UserQuestionProvider | undefined
  ctx.provide('userQuestions', {
    registerProvider: vi.fn((provider: UserQuestionProvider) => {
      questionProvider = provider
      return unregisterQuestions
    }),
  } as never)
  const exits: number[] = []
  provideCmdline(ctx, { args: [], exit: code => void exits.push(code) })
  const mounted: InkApplicationOptions[] = []
  return {
    agent,
    create,
    ctx,
    disposeHandle,
    exits,
    flush,
    mounted,
    order,
    questionProvider: () => questionProvider,
    resume,
    session,
    unregisterQuestions,
  }
}

function dependencies(
  fixture: RuntimeFixture,
  application: Partial<MountedInkApplication> = {},
): RuntimeDependencies {
  return {
    cwd: () => '/fixture/workspace',
    mountApplication: (options) => {
      fixture.mounted.push(options)
      return {
        dispose: application.dispose ?? (async () => undefined),
        exited: application.exited ?? new Promise<void>(() => undefined),
      }
    },
    sessionId: () => 'new-session',
    stdin: { isTTY: true },
    stdout: { isTTY: true },
  }
}

describe('startTuiRuntime', () => {
  it('composes a fresh exact-agent application and flushes before handle disposal', async () => {
    const fixture = runtimeFixture()
    let editorWasActiveDuringRendererDisposal = false
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture, {
        dispose: async () => {
          editorWasActiveDuringRendererDisposal = fixture.mounted[0]?.editor.insert('closing') === 'applied'
        },
      }),
    )

    expect(fixture.create).toHaveBeenCalledOnce()
    expect(fixture.resume).not.toHaveBeenCalled()
    expect(fixture.create.mock.calls[0]?.[0]).toMatchObject({
      meta: { cwd: '/fixture/workspace' },
      sessionId: 'new-session',
    })
    expect(fixture.mounted).toHaveLength(1)
    expect(fixture.mounted[0]?.sessionId).toBe('live-session')
    const editor = fixture.mounted[0]?.editor
    if (editor === undefined) throw new Error('editor was not mounted')

    await dispose()
    expect(editorWasActiveDuringRendererDisposal).toBe(true)
    expect(() => editor.insert('late')).toThrow('disposed')
    expect(fixture.flush).toHaveBeenCalledWith(fixture.agent.session)
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    expect(fixture.unregisterQuestions).toHaveBeenCalledOnce()
    expect(fixture.order).toEqual(['flush', 'handle'])
    await fixture.ctx.fiber.dispose()
  })

  it('resumes the requested session and makes application quit use launcher exit', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      { resumeSessionId: 'persisted-session' },
      new AbortController().signal,
      dependencies(fixture),
    )

    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.resume.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: 'persisted-session',
    })
    fixture.mounted[0]?.onQuit(0)
    await vi.waitFor(() => {
      expect(fixture.exits).toEqual([0])
    })
    await dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('composes durable tool presentation, approval, and structured questions', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture),
    )
    const application = fixture.mounted[0]
    if (application === undefined) throw new Error('application was not mounted')
    const callId = 'composed-call' as CallId
    fixture.session.append({
      data: { arguments: '{}', callId, name: 'fixture', step: 0, turn: 0 },
      seq: 0,
      time: 0,
      type: 'tool/call',
    })
    fixture.session.append({
      data: {
        message: {
          content: [{
            content: [{ text: 'durable composed output', type: 'text' }],
            toolCallId: callId,
            type: 'tool-result',
          }],
          id: 'composed-result' as MessageId,
          role: 'user',
          source: { callId, kind: 'tool' },
        },
        step: 0,
        turn: 0,
      },
      seq: 1,
      time: 1,
      type: 'tool/result',
    })
    await vi.waitFor(() => {
      expect(application.transcript.getSnapshot().rows[0]?.toolCard).toMatchObject({
        card: 'terminal',
        lines: ['$ echo composed', 'composed', 'exit: 0'],
      })
    })

    const approval = fixture.agent.ctx.waterfall(
      'approval/request',
      { agent: fixture.agent, reason: 'needed', toolName: 'fixture' },
      () => Promise.resolve('unavailable'),
    )
    await vi.waitFor(() => {
      expect(application.interaction.getSnapshot()).toMatchObject({ kind: 'approval' })
    })
    application.interaction.answerApproval('allowed-once')
    await expect(approval).resolves.toBe('allowed-once')

    const provider = fixture.questionProvider()
    if (provider === undefined) throw new Error('question provider was not registered')
    const question = provider.ask({
      agent: fixture.agent,
      questions: [{
        id: 'continue',
        options: [{ label: 'Yes' }, { label: 'No' }],
        question: 'Continue?',
      }],
    })
    await vi.waitFor(() => {
      expect(application.interaction.getSnapshot()).toMatchObject({ kind: 'questions' })
    })
    const answer = { answers: [{ id: 'continue', selected: ['Yes'] }] }
    application.interaction.answerQuestions(answer)
    await expect(question).resolves.toEqual(answer)

    await dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('refuses non-TTY streams before creating an agent', async () => {
    const fixture = runtimeFixture()
    await expect(startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      { ...dependencies(fixture), stdin: { isTTY: false } },
    )).rejects.toThrow('interactive TTY')
    expect(fixture.create).not.toHaveBeenCalled()
    await fixture.ctx.fiber.dispose()
  })

  it('requests a failing launcher exit and reports renderer failure after teardown', async () => {
    const fixture = runtimeFixture()
    const rendererFailure = new Error('renderer failed')
    let rejectRenderer!: (error: unknown) => void
    const rendererExit = new Promise<void>((_resolve, reject) => {
      rejectRenderer = reject
    })
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture, {
        dispose: async () => { throw rendererFailure },
        exited: rendererExit,
      }),
    )
    rejectRenderer(rendererFailure)

    await vi.waitFor(() => {
      expect(fixture.exits).toEqual([1])
    })
    await expect(dispose()).rejects.toThrow('TUI renderer and runtime cleanup both failed')
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await fixture.ctx.fiber.dispose()
  })
})
