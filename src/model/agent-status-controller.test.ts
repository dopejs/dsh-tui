import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'

import { AgentStatusController } from './agent-status-controller'

function fixture(status: AgentStatus = 'idle') {
  const ctx = new Context()
  const agent = { ctx, id: 'root', status } as unknown as Agent
  return { agent, ctx }
}

describe('AgentStatusController', () => {
  it('publishes only exact-agent status transitions', () => {
    const { agent, ctx } = fixture()
    const controller = new AgentStatusController(agent)
    const changed = vi.fn()
    controller.subscribe(changed)

    ctx.emit('agent/status', { agent: fixture().agent, status: 'running' })
    expect(controller.getSnapshot()).toBe('idle')
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(controller.getSnapshot()).toBe('running')
    expect(changed).toHaveBeenCalledOnce()

    controller.dispose()
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect(controller.getSnapshot()).toBe('running')
  })

  it('contains observer failures and refuses subscriptions after disposal', () => {
    const { agent, ctx } = fixture()
    const errors: unknown[] = []
    const controller = new AgentStatusController(agent, error => errors.push(error))
    controller.subscribe(() => { throw new Error('observer failed') })

    ctx.emit('agent/status', { agent, status: 'running' })
    expect(errors).toHaveLength(1)
    controller.dispose()
    expect(() => controller.subscribe(() => undefined)).toThrow('disposed')
  })
})
