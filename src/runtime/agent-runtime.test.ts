import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  AgentRegistry,
  type Agent,
  type AgentFactory,
  type CreateAgentOptions,
} from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { createAgentRuntimePlugin } from './agent-runtime.js'

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

function fixtureAgent() {
  const agentCtx = new Context()
  const session = {
    events: Object.freeze([]),
    seq: 0,
  } as unknown as Session
  return {
    agent: {
      ctx: agentCtx,
      id: 'runtime-fixture',
      options: {},
      session,
      status: 'idle',
    } as unknown as Agent,
    agentCtx,
  }
}

function provideServices(ctx: Context) {
  const fixture = fixtureAgent()
  const disposeHandle = vi.fn(async () => {
    await fixture.agentCtx.fiber.dispose()
  })
  const create = vi.fn(async (options: CreateAgentOptions) => {
    await options.setup?.(fixture.agentCtx)
    return { agent: fixture.agent, dispose: disposeHandle }
  })
  ctx.provide('agents', { create, resume: vi.fn() } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ model: 'fixture-model', provider: 'fixture-provider' }),
  } as never)
  return { create, disposeHandle }
}

describe('createAgentRuntimePlugin', () => {
  it('runs through the published AgentRegistry and default-model services', async () => {
    const ctx = new Context()
    const fixture = fixtureAgent()
    const disposeHandle = vi.fn(async () => {
      await fixture.agentCtx.fiber.dispose()
    })
    const factory: AgentFactory = {
      createAgent: vi.fn(async (_ownerCtx, options) => {
        await options.setup?.(fixture.agentCtx)
        return { agent: fixture.agent, dispose: disposeHandle }
      }),
      resume: vi.fn(),
    }
    const registryFiber = ctx.plugin(AgentRegistry)
    const modelFiber = ctx.plugin(AgentDefaultModelConfig, {
      model: 'fixture-model',
      provider: 'fixture-provider',
    })
    await Promise.all([registryFiber, modelFiber])
    ctx.agents.setFactory(factory)

    const fiber = ctx.plugin(createAgentRuntimePlugin({
      onEvents: () => undefined,
      request: {
        cwd: resolve('fixture-workspace'),
        kind: 'create',
        sessionId: 'runtime-session',
      },
    }))
    await fiber
    await vi.waitFor(() => {
      expect(factory.createAgent).toHaveBeenCalledOnce()
    })

    await fiber.dispose()
    expect(disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('composes loader settlement, attachment, and runtime disposal', async () => {
    const ctx = new Context()
    const services = provideServices(ctx)
    const settlement = deferred<undefined>()
    ctx.provide('loader', { await: () => settlement.promise } as never)
    const onEvents = vi.fn()
    const fiber = ctx.plugin(createAgentRuntimePlugin({
      onEvents,
      request: {
        cwd: resolve('fixture-workspace'),
        kind: 'create',
        sessionId: 'runtime-session',
      },
    }))

    await fiber
    expect(services.create).not.toHaveBeenCalled()

    settlement.resolve(undefined)
    await vi.waitFor(() => {
      expect(services.create).toHaveBeenCalledOnce()
    })

    await fiber.dispose()
    expect(services.disposeHandle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('does not create an agent when disposed during loader settlement', async () => {
    const ctx = new Context()
    const services = provideServices(ctx)
    const settlement = deferred<undefined>()
    ctx.provide('loader', { await: () => settlement.promise } as never)
    const fiber = ctx.plugin(createAgentRuntimePlugin({
      onEvents: () => undefined,
      request: {
        cwd: resolve('fixture-workspace'),
        kind: 'create',
        sessionId: 'runtime-session',
      },
    }))

    await fiber
    await fiber.dispose()
    settlement.resolve(undefined)
    await Promise.resolve()

    expect(services.create).not.toHaveBeenCalled()
    expect(services.disposeHandle).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
