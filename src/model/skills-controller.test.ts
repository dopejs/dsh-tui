import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillCatalogSnapshot, SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'

import { SkillsController } from './skills-controller'

function summary(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    description: `does ${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
    name,
    provider: 'filesystem',
    source: 'project-dsh',
    ...overrides,
  } as SkillSummary
}

class FakeSkillRegistry {
  readonly get = vi.fn<(name: string, options?: unknown) => Promise<SkillDefinition | undefined>>()
  readonly snapshot = vi.fn<(options?: unknown) => Promise<SkillCatalogSnapshot>>(
    async () => ({ complete: true, skills: [] }),
  )
}

describe('SkillsController (M4.2)', () => {
  it('is unavailable without the registry and invents no catalog', async () => {
    const controller = new SkillsController()
    expect(controller.getSnapshot()).toMatchObject({ rows: [], status: 'unavailable' })
    await expect(controller.refresh()).resolves.toBe(false)
    await expect(controller.inspect()).resolves.toBe(false)
    controller.dispose()
  })

  // No public hook inventory exists on this baseline; a panel could only be
  // built by reading private configuration or by running a hook to observe it.
  it('reports hooks as unsupported rather than inventing an inventory', () => {
    const controller = new SkillsController(undefined, new FakeSkillRegistry())
    expect(controller.getSnapshot().hooks).toBe('unsupported-no-public-inventory')
    controller.dispose()
  })

  it('projects the catalog with invocation controls and provenance', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({
      complete: true,
      skills: [
        summary('review-code', { whenToUse: 'before merging' }),
        summary('internal-only', {
          invocation: { modelInvocable: true, userInvocable: false },
          provider: 'runtime',
          source: 'runtime',
        }),
      ],
    })
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()

    const snapshot = controller.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.complete).toBe(true)
    expect(snapshot.rows[0]).toMatchObject({
      name: 'review-code',
      provider: 'filesystem',
      source: 'project-dsh',
      userInvocable: true,
      whenToUse: 'before merging',
    })
    expect(snapshot.rows[1]?.userInvocable).toBe(false)
    controller.dispose()
  })

  it('passes the viewing scope, cwd, and an abort signal to discovery', async () => {
    const agent = { id: 'session' } as unknown as Agent
    const registry = new FakeSkillRegistry()
    const controller = new SkillsController(agent, registry, { cwd: () => '/work' })
    await controller.refresh()

    expect(registry.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/work',
      scope: agent,
      signal: expect.any(AbortSignal),
    }))
    controller.dispose()
  })

  // An incomplete observation is usable but must not be presented as the truth.
  it('surfaces incomplete discovery as partial instead of authoritative', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({ complete: false, skills: [summary('partial')] })
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({ complete: false, status: 'ready' })
    expect(controller.getSnapshot().rows).toHaveLength(1)
    controller.dispose()
  })

  it('filters by name and description and keeps the total match count', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({
      complete: true,
      skills: [summary('review-code'), summary('deploy'), summary('audit', {
        description: 'review the change index',
      })],
    })
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()

    controller.setQuery('review')
    expect(controller.getSnapshot().rows.map(row => row.name)).toEqual(['review-code', 'audit'])
    expect(controller.getSnapshot().totalMatches).toBe(2)

    controller.setQuery('')
    expect(controller.getSnapshot().rows).toHaveLength(3)
    controller.dispose()
  })

  it('keeps selection on its skill name across filtering and refresh', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({
      complete: true,
      skills: [summary('a'), summary('b'), summary('c')],
    })
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()
    controller.move('down')
    expect(controller.selected()?.name).toBe('b')

    registry.snapshot.mockResolvedValue({
      complete: true,
      skills: [summary('new'), summary('a'), summary('b'), summary('c')],
    })
    await controller.refresh()
    expect(controller.selected()?.name).toBe('b')

    // Filtering the selection away falls back to the first row.
    controller.setQuery('new')
    expect(controller.selected()?.name).toBe('new')
    controller.dispose()
  })

  it('loads a skill body for reading without invoking it', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({ complete: true, skills: [summary('review-code')] })
    registry.get.mockResolvedValue({
      ...summary('review-code'),
      content: 'Read the diff first.',
      path: '/skills/review-code/SKILL.md',
    } as SkillDefinition)
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()

    await expect(controller.inspect()).resolves.toBe(true)
    expect(controller.getSnapshot().detail).toMatchObject({
      content: 'Read the diff first.',
      name: 'review-code',
      path: '/skills/review-code/SKILL.md',
      truncated: false,
    })
    controller.dispose()
  })

  it('bounds a large skill body and marks it truncated', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({ complete: true, skills: [summary('big')] })
    registry.get.mockResolvedValue({
      ...summary('big'),
      content: 'x'.repeat(100),
    } as SkillDefinition)
    const controller = new SkillsController(undefined, registry, { maxDetailCodeUnits: 10 })
    await controller.refresh()

    await controller.inspect()
    expect(controller.getSnapshot().detail).toMatchObject({ truncated: true })
    expect(controller.getSnapshot().detail?.content).toHaveLength(10)
    controller.dispose()
  })

  it('reports a skill that is no longer loadable', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({ complete: true, skills: [summary('gone')] })
    registry.get.mockResolvedValue(undefined)
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()

    await expect(controller.inspect()).resolves.toBe(false)
    expect(controller.getSnapshot().error).toContain('no longer loadable')
    controller.dispose()
  })

  it('offers an invocation only for user-invocable skills', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({
      complete: true,
      skills: [summary('usable'), summary('model-only', {
        invocation: { modelInvocable: true, userInvocable: false },
      })],
    })
    const controller = new SkillsController(undefined, registry)
    await controller.refresh()

    expect(controller.invocationFor()).toBe('/usable')
    controller.move('down')
    expect(controller.invocationFor()).toBeUndefined()
    controller.dispose()
  })

  it('discards a stale discovery that resolves after a newer one', async () => {
    const registry = new FakeSkillRegistry()
    let releaseSlow: (value: SkillCatalogSnapshot) => void = () => undefined
    registry.snapshot.mockImplementationOnce(async () => new Promise((resolve) => {
      releaseSlow = resolve
    }))
    registry.snapshot.mockImplementationOnce(async () => ({
      complete: true,
      skills: [summary('fresh')],
    }))
    const controller = new SkillsController(undefined, registry)

    const slow = controller.refresh()
    await controller.refresh()
    expect(controller.getSnapshot().rows.map(row => row.name)).toEqual(['fresh'])

    releaseSlow({ complete: true, skills: [summary('stale')] })
    await expect(slow).resolves.toBe(false)
    expect(controller.getSnapshot().rows.map(row => row.name)).toEqual(['fresh'])
    controller.dispose()
  })

  it('surfaces a discovery failure and recovers on the next run', async () => {
    const reportError = vi.fn()
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockRejectedValueOnce(new Error('provider unreachable'))
    const controller = new SkillsController(undefined, registry, { reportError })

    await expect(controller.refresh()).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      error: 'provider unreachable',
      status: 'error',
    })
    expect(reportError).toHaveBeenCalled()

    registry.snapshot.mockResolvedValue({ complete: true, skills: [summary('a')] })
    await expect(controller.refresh()).resolves.toBe(true)
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('bounds the catalog and reports truncation', async () => {
    const registry = new FakeSkillRegistry()
    registry.snapshot.mockResolvedValue({
      complete: true,
      skills: Array.from({ length: 6 }, (_, index) => summary(`s${String(index)}`)),
    })
    const controller = new SkillsController(undefined, registry, { maxSkills: 3 })
    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({ totalMatches: 6, truncated: true })
    expect(controller.getSnapshot().rows).toHaveLength(3)
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    expect(() => new SkillsController(undefined, undefined, { maxSkills: 0 }))
      .toThrow('maxSkills must be a positive safe integer')
    expect(() => new SkillsController(undefined, undefined, { maxDetailCodeUnits: -1 }))
      .toThrow('maxDetailCodeUnits must be a positive safe integer')
  })

  it('aborts pending discovery on disposal and never updates afterwards', async () => {
    const registry = new FakeSkillRegistry()
    let observed: AbortSignal | undefined
    registry.snapshot.mockImplementation(async (options) => {
      observed = (options as { signal?: AbortSignal }).signal
      return new Promise((_resolve, reject) => {
        observed?.addEventListener('abort', () => reject(new Error('CANCELLED')))
      })
    })
    const controller = new SkillsController(undefined, registry)
    const listener = vi.fn()
    controller.subscribe(listener)
    const pending = controller.refresh()

    controller.dispose()

    expect(observed?.aborted).toBe(true)
    await expect(pending).resolves.toBe(false)
    await expect(controller.refresh()).rejects.toThrow('SkillsController is disposed')
    controller.dispose()
  })
})
