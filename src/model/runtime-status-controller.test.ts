import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { RuntimeStatusController } from './runtime-status-controller'

describe('RuntimeStatusController (M1.5)', () => {
  it('omits unavailable facts and publishes a model that becomes available later', () => {
    const controller = new RuntimeStatusController()
    expect(controller.getSnapshot()).toEqual({ revision: 0 })
    controller.setModel({ model: 'late-model', provider: 'late-provider' })
    expect(controller.getSnapshot()).toMatchObject({
      model: 'late-provider/late-model',
      revision: 1,
    })
    controller.dispose()
  })

  it('projects model, permission, and approval while usage stays projection-owned', () => {
    const controller = new RuntimeStatusController({ model: 'old', provider: 'provider' })
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.accept([{
      data: { preset: 'workspace-write' }, seq: 0, time: 0, type: 'permission/preset',
    }, {
      data: { policy: 'never' }, seq: 1, time: 1, type: 'approval/policy',
    }, {
      data: { contextWindow: 128_000, model: 'new', provider: 'provider' },
      seq: 2, time: 2, type: 'request/context',
    }] as SessionEvent[])

    expect(controller.getSnapshot()).toMatchObject({
      approvalPolicy: 'never',
      model: 'provider/new',
      permissionPreset: 'workspace-write',
    })
    expect(listener).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('rejects sequence gaps and stops notifying after disposal', () => {
    const controller = new RuntimeStatusController()
    expect(() => controller.accept([{
      data: {}, seq: 1, time: 0, type: 'turn/start',
    } as SessionEvent])).toThrow('sequence gap')
    controller.dispose()
    expect(() => controller.setModel({ model: String(SessionId('m')), provider: 'p' })).toThrow('disposed')
  })

  it('does not build a competing usage projection from durable messages', () => {
    const controller = new RuntimeStatusController()
    controller.accept([{
      data: {
        message: {
          content: [], id: 'message' as never, role: 'assistant',
          source: { kind: 'model', model: 'model', provider: 'provider' },
        },
        step: 0,
        turn: 0,
        usage: { cacheReadTokens: 30, inputTokens: 100, outputTokens: 20 },
      },
      seq: 0,
      time: 0,
      type: 'assistant/message',
    }] as SessionEvent[])
    expect(controller.getSnapshot()).toEqual({ revision: 0 })
    controller.dispose()
  })
})
