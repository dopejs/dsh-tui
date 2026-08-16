import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  parseModelSelector,
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
  readonly inspectSession: ReturnType<typeof vi.fn>
  readonly listSessions: ReturnType<typeof vi.fn>
  readonly mounted: InkApplicationOptions[]
  readonly order: string[]
  readonly permissionSet: ReturnType<typeof vi.fn>
  readonly questionProvider: () => UserQuestionProvider | undefined
  readonly readRaw: ReturnType<typeof vi.fn>
  readonly resume: ReturnType<typeof vi.fn>
  readonly resolveModel: ReturnType<typeof vi.fn>
  readonly session: FixtureSession
  readonly unregisterQuestions: ReturnType<typeof vi.fn>
}

class FixtureSession {
  readonly #ctx: Context
  readonly #events: SessionEvent[] = []
  readonly header: { cwd: string, id: string }
  readonly id: string

  constructor(ctx: Context, id = 'live-session') {
    this.#ctx = ctx
    this.header = { cwd: '/fixture/workspace', id }
    this.id = id
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

function runtimeFixture(options: { readonly rawArtifacts?: boolean } = {}): RuntimeFixture {
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
    if (options.meta?.parentSession !== undefined) {
      const childCtx = new Context()
      const childSessionId = String(options.sessionId)
      const childSession = new FixtureSession(childCtx, childSessionId)
      const childAgent = {
        cancel: vi.fn(),
        ctx: childCtx,
        followup: vi.fn(),
        id: childSessionId,
        options: options.agentOptions ?? {},
        session: childSession as unknown as Session,
        status: 'idle',
        steer: vi.fn(),
      } as unknown as Agent
      await options.setup?.(childCtx)
      return {
        agent: childAgent,
        dispose: async () => {
          order.push(`handle:${childSessionId}`)
          await childCtx.fiber.dispose()
        },
      }
    }
    await options.setup?.(agentCtx)
    return handle
  })
  const resume = vi.fn(async (options: ResumeAgentOptions) => {
    if (options.resumeSessionId === 'target-session') {
      const targetCtx = new Context()
      const targetSession = new FixtureSession(targetCtx, 'target-session')
      const targetAgent = {
        cancel: vi.fn(),
        ctx: targetCtx,
        followup: vi.fn(),
        id: 'target-session',
        options: { model: 'fixture-model', provider: 'fixture-provider' },
        session: targetSession as unknown as Session,
        status: 'idle',
        steer: vi.fn(),
      } as unknown as Agent
      await options.setup?.(targetCtx)
      return {
        agent: targetAgent,
        dispose: async () => {
          order.push('handle:target-session')
          await targetCtx.fiber.dispose()
        },
      }
    }
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
  ctx.provide('commands', {
    execute: vi.fn(),
    list: vi.fn(() => []),
    register: vi.fn(() => unregisterCommand),
  } as never)
  const resolveModel = vi.fn(async (provider: string, model: string) => ({
    id: model,
    name: model,
    provider,
  }))
  ctx.provide('llm', { resolveModelInfo: resolveModel } as never)
  let permissionCurrent = 'workspace-write'
  const permissionSet = vi.fn((target: Session, value: string) => {
    void target
    permissionCurrent = value
  })
  ctx.provide('permissionPresets', {
    current: vi.fn(() => permissionCurrent),
    names: ['workspace-write', 'danger-full-access'],
    optionOf: vi.fn((value: string) => ({ name: value, value })),
    resolve: vi.fn((value: string) => value === 'danger-full-access'
      ? { approval: 'never', sandbox: 'danger-full-access' }
      : { approval: 'ask', sandbox: 'workspace-write' }),
    set: permissionSet,
  } as never)
  const inspectSession = vi.fn(async (id) => ({
      events: session.events,
      meta: { createdAt: 0, cwd: '/fixture/workspace', id, version: 0 },
    }))
  const listSessions = vi.fn(async () => [])
  const readRaw = vi.fn(async () => options.rawArtifacts === true
    ? {
        content: 'durable raw session\n',
        filename: 'live-session.jsonl',
        meta: { id: 'live-session' },
      }
    : undefined)
  ctx.provide('sessionPersistence', {
    inspect: inspectSession,
    list: listSessions,
    locate: () => options.rawArtifacts === true
      ? { kind: 'jsonl', path: '/fixture/sessions/live-session.jsonl' }
      : undefined,
    readRaw,
    supportsRawArtifacts: options.rawArtifacts === true,
  } as never)
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
    inspectSession,
    listSessions,
    mounted,
    order,
    permissionSet,
    questionProvider: () => questionProvider,
    readRaw,
    resume,
    resolveModel,
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

function currentApplication(fixture: RuntimeFixture) {
  return fixture.mounted[0]?.sessions.getSnapshot().binding?.application
}

describe('startTuiRuntime', () => {
  it('parses a provider and slash-containing model without changing identity', () => {
    expect(parseModelSelector('gateway/org/model')).toEqual({
      model: 'org/model',
      provider: 'gateway',
    })
    expect(() => parseModelSelector('model-only')).toThrow('provider/model')
  })

  it('composes a fresh exact-agent application and flushes before handle disposal', async () => {
    const fixture = runtimeFixture()
    let editorWasActiveDuringRendererDisposal = false
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture, {
        dispose: async () => {
          editorWasActiveDuringRendererDisposal = currentApplication(fixture)?.editor.insert('closing') === 'applied'
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
    expect(currentApplication(fixture)?.sessionId).toBe('live-session')
    const editor = currentApplication(fixture)?.editor
    const overlay = currentApplication(fixture)?.overlay
    const palette = currentApplication(fixture)?.palette
    const completion = currentApplication(fixture)?.completion
    const permission = currentApplication(fixture)?.permission
    const recovery = currentApplication(fixture)?.recovery
    if (
      editor === undefined
      || overlay === undefined
      || palette === undefined
      || completion === undefined
      || permission === undefined
      || recovery === undefined
    ) {
      throw new Error('interactive controllers were not mounted')
    }

    await dispose()
    expect(editorWasActiveDuringRendererDisposal).toBe(true)
    expect(() => editor.insert('late')).toThrow('disposed')
    expect(() => overlay.open('command-palette')).toThrow('disposed')
    expect(() => palette.insertQuery('late')).toThrow('disposed')
    expect(() => completion.request('/late', 5)).toThrow('disposed')
    expect(() => permission.requestSelected()).toThrow('disposed')
    expect(() => recovery.activateSelected()).toThrow('disposed')
    expect(fixture.flush).toHaveBeenCalledWith(fixture.agent.session)
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    expect(fixture.unregisterQuestions).toHaveBeenCalledOnce()
    expect(fixture.order).toEqual(['flush', 'handle'])
    await fixture.ctx.fiber.dispose()
  })

  it('routes durability through the exact session and gates unsupported recovery', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture),
    )
    const recovery = currentApplication(fixture)?.recovery
    if (recovery === undefined) throw new Error('recovery controller was not mounted')

    expect(recovery.getSnapshot().capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ available: false, id: 'export' }),
      expect.objectContaining({ available: false, id: 'file-rewind' }),
    ]))
    expect(recovery.activateSelected()).toBe('started')
    await vi.waitFor(() => expect(recovery.getSnapshot().status).toBe('success'))
    expect(fixture.flush).toHaveBeenCalledWith(fixture.agent.session)

    await dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('forks through public agent seed/lineage creation without overlapping bindings', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture),
    )
    const recovery = currentApplication(fixture)?.recovery
    const sessions = fixture.mounted[0]?.sessions
    if (recovery === undefined || sessions === undefined) {
      throw new Error('recovery runtime was not mounted')
    }

    recovery.move('down')
    recovery.move('down')
    expect(recovery.activateSelected()).toBe('confirmation-required')
    expect(recovery.confirm()).toBe(true)
    await vi.waitFor(() => expect(sessions.getSnapshot()).toMatchObject({
      binding: { sessionId: 'new-session' },
      status: 'attached',
    }))

    expect(fixture.create).toHaveBeenCalledTimes(2)
    expect(fixture.create.mock.calls[1]?.[0]).toMatchObject({
      meta: {
        cwd: '/fixture/workspace',
        parentSession: 'live-session',
        seedLength: 0,
      },
      seed: [],
      sessionId: 'new-session',
    })
    expect(fixture.order).toEqual(['flush', 'flush', 'handle'])
    fixture.listSessions.mockResolvedValue([{
      createdAt: 2,
      cwd: '/fixture/workspace',
      id: 'new-session',
      parentSession: 'live-session',
      seedLength: 0,
      version: 0,
    }, {
      createdAt: 1,
      cwd: '/fixture/workspace',
      id: 'live-session',
      version: 0,
    }])
    fixture.mounted[0]?.sessionCenter.refresh()
    await vi.waitFor(() => expect(
      fixture.mounted[0]?.sessionCenter.getSnapshot().items[0],
    ).toMatchObject({ id: 'new-session', isCurrent: true }))

    await dispose()
    expect(fixture.order).toEqual([
      'flush',
      'flush',
      'handle',
      'flush',
      'handle:new-session',
    ])
    await fixture.ctx.fiber.dispose()
  })

  it('exports the exact backend-owned raw artifact through the recovery adapter', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-runtime-export-'))
    const fixture = runtimeFixture({ rawArtifacts: true })
    let dispose: (() => Promise<void>) | undefined
    try {
      dispose = await startTuiRuntime(
        fixture.ctx,
        {},
        new AbortController().signal,
        dependencies(fixture),
      )
      const recovery = currentApplication(fixture)?.recovery
      if (recovery === undefined) throw new Error('recovery controller was not mounted')
      recovery.move('down')
      expect(recovery.activateSelected()).toBe('input-required')
      const destination = join(workspace, 'export.jsonl')
      recovery.insertDestination(destination)
      recovery.confirm()
      await vi.waitFor(() => expect(recovery.getSnapshot().status).toBe('success'))

      expect(await readFile(destination, 'utf8')).toBe('durable raw session\n')
      expect(fixture.readRaw).toHaveBeenCalledWith(
        'live-session',
        expect.any(AbortSignal),
      )
      await dispose()
      dispose = undefined
    } finally {
      await dispose?.()
      await fixture.ctx.fiber.dispose()
      await rm(workspace, { recursive: true })
    }
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

  it('resolves and applies an exact model selection before creating a fresh agent', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      { model: 'selected-provider/org/selected-model' },
      new AbortController().signal,
      dependencies(fixture),
    )

    expect(fixture.resolveModel).toHaveBeenCalledWith(
      'selected-provider',
      'org/selected-model',
      expect.any(AbortSignal),
    )
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: {
        model: 'org/selected-model',
        provider: 'selected-provider',
      },
    }))
    await dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('does not create a session when exact model preflight fails', async () => {
    const fixture = runtimeFixture()
    fixture.resolveModel.mockRejectedValueOnce(new Error('model route unavailable'))

    await expect(startTuiRuntime(
      fixture.ctx,
      { model: 'missing/model' },
      new AbortController().signal,
      dependencies(fixture),
    )).rejects.toThrow('model route unavailable')
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.mounted).toHaveLength(0)
    await fixture.ctx.fiber.dispose()
  })

  it('switches the mounted runtime to the exact persisted session without overlapping handles', async () => {
    const fixture = runtimeFixture()
    fixture.listSessions.mockResolvedValue([{
      createdAt: 2,
      cwd: '/fixture/workspace',
      id: 'live-session',
      version: 0,
    }, {
      createdAt: 1,
      cwd: '/fixture/workspace',
      id: 'target-session',
      version: 0,
    }])
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture),
    )
    const mounted = fixture.mounted[0]
    if (mounted === undefined) throw new Error('application was not mounted')

    mounted.sessionCenter.refresh()
    await vi.waitFor(() => {
      expect(mounted.sessionCenter.getSnapshot()).toMatchObject({
        status: 'ready',
        totalMatches: 2,
      })
    })
    mounted.sessionCenter.move('down')
    expect(mounted.sessionCenter.selected()?.id).toBe('target-session')
    expect(mounted.sessionCenter.resumeSelected()).toBe(true)
    await vi.waitFor(() => {
      expect(mounted.sessions.getSnapshot()).toMatchObject({
        binding: { sessionId: 'target-session' },
        status: 'attached',
      })
      expect(mounted.sessionCenter.selected()).toMatchObject({
        id: 'target-session',
        isCurrent: true,
      })
    })

    expect(fixture.resume).toHaveBeenLastCalledWith(expect.objectContaining({
      resumeSessionId: 'target-session',
    }))
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    expect(fixture.order).toEqual(['flush', 'handle'])
    await dispose()
    expect(fixture.order).toEqual(['flush', 'handle', 'flush', 'handle:target-session'])
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
    const application = currentApplication(fixture)
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

  it('routes a confirmed permission change to the exact attached session', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture),
    )
    const permission = currentApplication(fixture)?.permission
    if (permission === undefined) throw new Error('permission controller was not mounted')

    permission.move('down')
    expect(permission.requestSelected()).toBe('confirmation-required')
    permission.insertConfirmation('enable danger-full-access')
    expect(permission.confirm()).toBe(true)
    expect(fixture.permissionSet).toHaveBeenCalledWith(
      fixture.agent.session,
      'danger-full-access',
    )

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

  it('M2.4-F03 fails closed and disposes the exact attachment when a live projection rejects', async () => {
    const fixture = runtimeFixture()
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture),
    )

    fixture.session.append({
      data: {},
      seq: 0,
      time: 0,
      type: 'user/message',
    } as SessionEvent)

    await vi.waitFor(() => expect(fixture.exits).toEqual([1]))
    expect(fixture.flush).toHaveBeenCalledWith(fixture.agent.session)
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await expect(dispose()).resolves.toBeUndefined()
    await fixture.ctx.fiber.dispose()
  })

  it('M2.4-F07 treats terminal output closure as fatal and reaches a clean process boundary', async () => {
    const fixture = runtimeFixture()
    const outputFailure = Object.assign(new Error('stdout pipe closed'), { code: 'EPIPE' })
    let rejectRenderer!: (error: unknown) => void
    const rendererExit = new Promise<void>((_resolve, reject) => {
      rejectRenderer = reject
    })
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture, { exited: rendererExit }),
    )

    rejectRenderer(outputFailure)
    await vi.waitFor(() => expect(fixture.exits).toEqual([1]))
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await expect(dispose()).rejects.toBe(outputFailure)
    await fixture.ctx.fiber.dispose()
  })

  it('M2.4-F06/F08 preserves renderer and cleanup failures after teardown', async () => {
    const fixture = runtimeFixture()
    const rendererFailure = new Error('renderer failed')
    const applicationCleanupFailure = new Error('renderer cleanup failed')
    const flushFailure = new Error('durability cleanup failed')
    fixture.flush.mockRejectedValueOnce(flushFailure)
    let rejectRenderer!: (error: unknown) => void
    const rendererExit = new Promise<void>((_resolve, reject) => {
      rejectRenderer = reject
    })
    const dispose = await startTuiRuntime(
      fixture.ctx,
      {},
      new AbortController().signal,
      dependencies(fixture, {
        dispose: async () => { throw applicationCleanupFailure },
        exited: rendererExit,
      }),
    )
    rejectRenderer(rendererFailure)

    await vi.waitFor(() => {
      expect(fixture.exits).toEqual([1])
    })
    let caught: unknown
    try {
      await dispose()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({
      errors: [rendererFailure, expect.any(AggregateError)],
      message: 'TUI renderer and runtime cleanup both failed',
    })
    const cleanup = (caught as AggregateError).errors[1]
    expect(cleanup).toMatchObject({
      errors: [
        expect.objectContaining({
          cause: applicationCleanupFailure,
          message: 'Failed to dispose Ink application and terminal state',
        }),
        expect.objectContaining({
          message: 'Failed to dispose session attachment coordinator',
        }),
      ],
      message: 'One or more owned resources failed to dispose',
    })
    expect(fixture.disposeHandle).toHaveBeenCalledOnce()
    await fixture.ctx.fiber.dispose()
  })
})
