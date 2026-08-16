import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, {
  CommandId,
  type CommandExecution,
  type CommandInvocation,
} from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { InputController } from './input-controller'

interface FakeAgent extends Agent {
  cancel: ReturnType<typeof vi.fn<Agent['cancel']>>
  followup: ReturnType<typeof vi.fn<Agent['followup']>>
  steer: ReturnType<typeof vi.fn<Agent['steer']>>
}

function fakeAgent(status: Agent['status'] = 'idle'): FakeAgent {
  return {
    cancel: vi.fn<Agent['cancel']>(),
    followup: vi.fn<Agent['followup']>(),
    status,
    steer: vi.fn<Agent['steer']>(),
  } as unknown as FakeAgent
}

function commandExecution(text = 'done'): CommandExecution {
  return {
    commandId: CommandId('fixture-command'),
    result: { kind: 'success', text },
  }
}

describe('InputController', () => {
  it('routes identified user messages to followup and steering without trimming', async () => {
    const agent = fakeAgent('running')
    const commands = { execute: vi.fn() }
    const controller = new InputController({ agent, commands })

    const followup = await controller.submit('  keep spacing  ', 'followup')
    const steering = await controller.submit('change direction', 'steer')

    expect(followup).toMatchObject({ kind: 'message', mode: 'followup' })
    expect(steering).toMatchObject({ kind: 'message', mode: 'steer' })
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.followup.mock.calls[0]?.[0]).toMatchObject({
      content: [{ text: '  keep spacing  ', type: 'text' }],
      role: 'user',
      source: { kind: 'user' },
    })
    expect(agent.steer).toHaveBeenCalledOnce()
    expect(commands.execute).not.toHaveBeenCalled()
    expect(controller.agentStatus).toBe('running')
    await controller.dispose()
  })

  it('M2.4-F01 contains followup and steering failures as recoverable submission results', async () => {
    const followupFailure = new Error('followup queue unavailable')
    const steeringFailure = new Error('steering window closed')
    const agent = fakeAgent('running')
    agent.followup.mockImplementationOnce(() => { throw followupFailure })
    agent.steer.mockImplementationOnce(() => { throw steeringFailure })
    const controller = new InputController({ agent, commands: { execute: vi.fn() } })

    await expect(controller.submit('keep this draft', 'followup')).resolves.toEqual({
      error: followupFailure,
      kind: 'message-error',
      message: 'followup queue unavailable',
      mode: 'followup',
    })
    await expect(controller.submit('keep steering draft', 'steer')).resolves.toEqual({
      error: steeringFailure,
      kind: 'message-error',
      message: 'steering window closed',
      mode: 'steer',
    })
    expect(controller.commandPending).toBe(false)

    await controller.dispose()
  })

  it('rejects empty and over-budget input before touching the agent', async () => {
    const agent = fakeAgent()
    const controller = new InputController({
      agent,
      commands: { execute: vi.fn() },
      maxInputChars: 4,
    })

    await expect(controller.submit(' \t\n ', 'followup')).resolves.toMatchObject({
      code: 'empty',
      kind: 'rejected',
    })
    await expect(controller.submit('12345', 'followup')).resolves.toMatchObject({
      code: 'too-long',
      kind: 'rejected',
    })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('rejects malformed and unknown slash commands instead of sending them to the model', async () => {
    const agent = fakeAgent()
    const execute = vi.fn(async (
      agentArgument: Agent,
      lineArgument: string,
      signalArgument: AbortSignal,
    ) => {
      void agentArgument
      void lineArgument
      void signalArgument
      return undefined
    })
    const controller = new InputController({ agent, commands: { execute } })

    await expect(controller.submit('/Bad', 'followup')).resolves.toMatchObject({
      code: 'invalid-command',
      kind: 'rejected',
    })
    await expect(controller.submit('/missing exact args', 'steer')).resolves.toEqual({
      code: 'unknown-command',
      kind: 'rejected',
      message: 'Unknown command /missing',
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).toBe('/missing exact args')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('returns the exact settled command execution', async () => {
    const agent = fakeAgent()
    const execution = commandExecution()
    const execute = vi.fn(async () => execution)
    const controller = new InputController({ agent, commands: { execute } })

    await expect(controller.submit('/help  raw', 'followup')).resolves.toEqual({
      execution,
      kind: 'command',
    })
    expect(execute).toHaveBeenCalledWith(agent, '/help  raw', expect.any(AbortSignal))
    expect(controller.commandPending).toBe(false)
    await controller.dispose()
  })

  it('serializes commands while allowing command cancellation', async () => {
    const agent = fakeAgent()
    const execute = vi.fn((_agent: Agent, _line: string, signal: AbortSignal) =>
      new Promise<CommandExecution>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason)
        }, { once: true })
      }))
    const controller = new InputController({ agent, commands: { execute } })

    const first = controller.submit('/slow', 'followup')
    expect(controller.commandPending).toBe(true)
    await expect(controller.submit('/second', 'followup')).resolves.toMatchObject({
      code: 'busy',
      kind: 'rejected',
    })
    expect(controller.cancelCommand()).toBe(true)
    await expect(first).resolves.toEqual({ kind: 'command-cancelled' })
    await Promise.resolve()
    expect(controller.commandPending).toBe(false)
    expect(controller.cancelCommand()).toBe(false)
    await controller.dispose()
  })

  it('contains command failures for direct UI feedback', async () => {
    const failure = new Error('handler failed')
    const controller = new InputController({
      agent: fakeAgent(),
      commands: { execute: vi.fn(async () => { throw failure }) },
    })

    await expect(controller.submit('/fail', 'followup')).resolves.toEqual({
      error: failure,
      kind: 'command-error',
      message: 'handler failed',
    })
    await controller.dispose()
  })

  it('routes user cancellation to the exact agent', async () => {
    const agent = fakeAgent()
    const controller = new InputController({ agent, commands: { execute: vi.fn() } })

    controller.cancelAgent()
    expect(agent.cancel).toHaveBeenCalledOnce()
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    await controller.dispose()
  })

  it('aborts and awaits an owned command during idempotent disposal', async () => {
    const agent = fakeAgent()
    let commandSettled = false
    const execute = vi.fn((_agent: Agent, _line: string, signal: AbortSignal) =>
      new Promise<CommandExecution>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          commandSettled = true
          reject(signal.reason)
        }, { once: true })
      }))
    const controller = new InputController({ agent, commands: { execute } })
    const submitting = controller.submit('/slow', 'followup')

    const firstDispose = controller.dispose()
    expect(controller.dispose()).toBe(firstDispose)
    await firstDispose
    expect(commandSettled).toBe(true)
    await expect(submitting).resolves.toEqual({ kind: 'command-cancelled' })
    await expect(controller.submit('late', 'followup'))
      .rejects.toThrow('Input controller is disposed')
    expect(() => controller.cancelAgent()).toThrow('Input controller is disposed')
  })

  it('validates configured input bounds', () => {
    const agent = fakeAgent()
    expect(() => new InputController({
      agent,
      commands: { execute: vi.fn() },
      maxInputChars: 0,
    })).toThrow(RangeError)
  })

  it('executes through the published command runtime and records its durable lifecycle', async () => {
    const ctx = new Context()
    const commandFiber = ctx.plugin(CommandRuntime)
    await commandFiber
    const session = Session.create(SessionId('command-session'))
    const agent = {
      ...fakeAgent(),
      ctx,
      id: session.id,
      options: {},
      session,
    } as unknown as Agent
    const handler = vi.fn((invocation: CommandInvocation) => {
      void invocation
      return { kind: 'success' as const, text: 'real output' }
    })
    const unregister = ctx.commands.register({
      description: 'Fixture command',
      handler,
      name: 'fixture',
    })
    const controller = new InputController({ agent, commands: ctx.commands })

    const submission = await controller.submit('/fixture  exact', 'followup')

    expect(submission).toMatchObject({
      execution: { result: { kind: 'success', text: 'real output' } },
      kind: 'command',
    })
    expect(handler).toHaveBeenCalledOnce()
    const invocation = handler.mock.calls[0]?.[0]
    expect(invocation?.agent).toBe(agent)
    expect(invocation?.rawInput).toBe('  exact')
    expect(invocation?.signal).toBeInstanceOf(AbortSignal)
    expect(session.events.map(event => event.type)).toEqual(['command/run', 'command/done'])

    await controller.dispose()
    unregister()
    await commandFiber.dispose()
    await ctx.fiber.dispose()
  })
})
