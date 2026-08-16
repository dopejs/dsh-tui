import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PermissionPresetService, PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { PermissionController } from './permission-controller'

function fixture() {
  const ctx = new Context()
  const events: SessionEvent[] = []
  let current = 'workspace-write'
  const session = { events, id: 'owned-session' } as unknown as Session
  const agent = { ctx, session } as unknown as Agent
  const specs: Record<string, PresetSpec> = {
    'workspace-write': { approval: 'ask', sandbox: 'workspace-write' },
    'danger-full-access': { approval: 'never', sandbox: 'danger-full-access' },
  }
  const set = vi.fn((target: Session, value: string) => {
    if (target !== session) throw new Error('wrong session')
    current = value
    const event = {
      data: { preset: value },
      seq: events.length,
      time: events.length,
      type: 'permission/preset',
    } as unknown as SessionEvent
    events.push(event)
    ctx.emit('session/event', session, event)
  })
  const service = {
    current: vi.fn(() => current),
    names: Object.freeze(Object.keys(specs)),
    optionOf: vi.fn((value: string) => ({ name: value, value })),
    resolve: vi.fn((value: string) => {
      const spec = specs[value]
      if (spec === undefined) throw new Error('unknown preset')
      return spec
    }),
    set,
  } as unknown as PermissionPresetService
  return { agent, ctx, events, service, session, set, setCurrent: (value: string) => { current = value } }
}

describe('PermissionController (M2.1)', () => {
  it('shows an explicit unavailable state without a composed service', async () => {
    const source = fixture()
    const controller = new PermissionController(source.agent)
    expect(controller.getSnapshot()).toEqual({
      confirmationText: '', items: [], revision: 0, status: 'unavailable', truncated: false,
    })
    expect(controller.requestSelected()).toBe('unavailable')
    controller.dispose()
    await source.ctx.fiber.dispose()
  })

  it('applies a safe preset to the exact owned session', async () => {
    const source = fixture()
    source.setCurrent('danger-full-access')
    const controller = new PermissionController(source.agent, source.service)
    expect(controller.selected()?.value).toBe('danger-full-access')
    controller.move('up')
    expect(controller.requestSelected()).toBe('applied')
    expect(source.set).toHaveBeenCalledWith(source.session, 'workspace-write')
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(controller.selected()).toMatchObject({ selected: true, value: 'workspace-write' })
    controller.dispose()
    await source.ctx.fiber.dispose()
  })

  it('requires the full typed phrase before applying danger-full-access', async () => {
    const source = fixture()
    const controller = new PermissionController(source.agent, source.service)
    controller.move('down')
    expect(controller.requestSelected()).toBe('confirmation-required')
    expect(controller.getSnapshot()).toMatchObject({
      confirmationPhrase: 'enable danger-full-access', status: 'confirming',
    })
    controller.insertConfirmation('yes')
    expect(controller.confirm()).toBe(false)
    expect(source.set).not.toHaveBeenCalled()
    while (controller.backspaceConfirmation()) { /* clear rejected phrase */ }
    controller.insertConfirmation('enable danger-full-access')
    expect(controller.confirm()).toBe(true)
    expect(source.set).toHaveBeenCalledWith(source.session, 'danger-full-access')
    controller.dispose()
    await source.ctx.fiber.dispose()
  })

  it('M2.4-F04 contains failed changes, permits retry, and refreshes only the exact session', async () => {
    const source = fixture()
    const controller = new PermissionController(source.agent, source.service)
    const before = controller.getSnapshot().revision
    source.ctx.emit('session/event', { events: [] } as unknown as Session, {
      data: { turn: 0 }, seq: 0, time: 0, type: 'turn/start',
    })
    expect(controller.getSnapshot().revision).toBe(before)

    source.set.mockImplementationOnce(() => { throw new Error('policy write failed') })
    controller.move('down')
    controller.requestSelected()
    controller.insertConfirmation('enable danger-full-access')
    expect(controller.confirm()).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      error: 'policy write failed', status: 'error',
    })
    expect(controller.selected()).toMatchObject({ selected: true, value: 'workspace-write' })

    controller.move('down')
    expect(controller.requestSelected()).toBe('confirmation-required')
    controller.insertConfirmation('enable danger-full-access')
    expect(controller.confirm()).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.selected()).toMatchObject({ selected: true, value: 'danger-full-access' })
    controller.dispose()
    await source.ctx.fiber.dispose()
  })

  it('uses the confirmed target even if the current preset changes before confirmation', async () => {
    const source = fixture()
    const controller = new PermissionController(source.agent, source.service)
    controller.move('down')
    controller.requestSelected()
    source.setCurrent('custom')
    source.ctx.emit('session/event', source.session, {
      data: { turn: 0 }, seq: 0, time: 0, type: 'turn/start',
    })
    controller.insertConfirmation('enable danger-full-access')
    expect(controller.confirm()).toBe(true)
    expect(source.set).toHaveBeenCalledWith(source.session, 'danger-full-access')
    controller.dispose()
    await source.ctx.fiber.dispose()
  })

  it('bounds the retained preset catalog and presentation metadata', async () => {
    const source = fixture()
    const names = Array.from({ length: 101 }, (_, index) => `preset-${String(index)}`)
    const service = {
      current: () => 'preset-0',
      names,
      optionOf: (value: string) => ({ description: 'x'.repeat(2_000), name: 'n'.repeat(1_000), value }),
      resolve: () => ({ approval: 'ask', sandbox: 'workspace-write' }),
      set: vi.fn(),
    } as unknown as PermissionPresetService
    const controller = new PermissionController(source.agent, service)

    expect(controller.getSnapshot()).toMatchObject({ truncated: true })
    expect(controller.getSnapshot().items).toHaveLength(100)
    expect(controller.getSnapshot().items[0]?.name).toHaveLength(500)
    expect(controller.getSnapshot().items[0]?.description).toHaveLength(1_000)
    controller.dispose()
    await source.ctx.fiber.dispose()
  })
})
