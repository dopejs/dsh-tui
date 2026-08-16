import { describe, expect, it, vi } from 'vitest'

import { ActivityCenterController, type ActivityStore } from './activity-center-controller'
import type { JobsSnapshot } from './jobs-controller'
import type { ProjectionHubSnapshot } from './projection-hub-controller'
import type { SubagentTreeSnapshot } from './subagent-tree-controller'

class FakeStore<T> implements ActivityStore<T> {
  readonly listeners = new Set<() => void>()
  unsubscribes = 0
  #snapshot: T

  constructor(snapshot: T) {
    this.#snapshot = snapshot
  }

  getSnapshot = (): T => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.unsubscribes += 1
      this.listeners.delete(listener)
    }
  }

  emit(snapshot: T): void {
    this.#snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}

function jobsSnapshot(overrides: Partial<JobsSnapshot> = {}): JobsSnapshot {
  return {
    droppedNotices: 0,
    jobs: [],
    notices: [],
    outputCapability: 'unsupported-consuming-read',
    revision: 0,
    runningCount: 0,
    status: 'ready',
    truncated: false,
    ...overrides,
  }
}

function projectionSnapshot(overrides: Partial<ProjectionHubSnapshot> = {}): ProjectionHubSnapshot {
  return {
    capabilities: {
      goal: 'unavailable', plan: 'unavailable', todos: 'unavailable', usage: 'unavailable',
    },
    diagnostics: [],
    droppedDiagnostics: 0,
    droppedTodos: 0,
    revision: 0,
    rows: [],
    status: 'ready',
    ...overrides,
  }
}

function subagentSnapshot(overrides: Partial<SubagentTreeSnapshot> = {}): SubagentTreeSnapshot {
  return {
    busy: false,
    followupText: '',
    revision: 0,
    rootSessionId: 'root' as SubagentTreeSnapshot['rootSessionId'],
    rows: [],
    status: 'ready',
    truncated: false,
    unreadCount: 0,
    ...overrides,
  }
}

function harness(
  jobs = jobsSnapshot(),
  projections = projectionSnapshot(),
  subagents = subagentSnapshot(),
) {
  const stores = {
    jobs: new FakeStore(jobs),
    projections: new FakeStore(projections),
    subagents: new FakeStore(subagents),
  }
  return { ...stores, controller: new ActivityCenterController(stores) }
}

const NOTICE = (id: string, status: JobsSnapshot['notices'][number]['status']) => ({
  id: id as JobsSnapshot['notices'][number]['id'],
  label: `run ${id}`,
  status,
})

describe('ActivityCenterController (M3.4)', () => {
  it('starts empty and derives counts from the three sources', () => {
    const { controller, jobs, projections, subagents } = harness()
    expect(controller.getSnapshot()).toMatchObject({
      counts: { jobsRunning: 0, subagentsUnread: 0, todosOpen: 0 },
      rows: [],
      totalActivity: 0,
    })

    jobs.emit(jobsSnapshot({ runningCount: 2 }))
    subagents.emit(subagentSnapshot({ unreadCount: 3 }))
    projections.emit(projectionSnapshot({
      todos: [
        { content: 'done', status: 'completed' },
        { content: 'open', status: 'in_progress' },
        { content: 'later', status: 'pending' },
      ],
    }))

    expect(controller.getSnapshot().counts).toEqual({
      jobsRunning: 2,
      subagentsUnread: 3,
      todosOpen: 2,
    })
    controller.dispose()
  })

  it('combines plans, jobs, and agents into one navigable list', () => {
    const { controller, jobs, projections, subagents } = harness()
    jobs.emit(jobsSnapshot({ notices: [NOTICE('bash-1', 'failed')] }))
    subagents.emit(subagentSnapshot({ unreadCount: 2 }))
    projections.emit(projectionSnapshot({ plan: { active: true, pending: true } }))

    const snapshot = controller.getSnapshot()
    expect(snapshot.rows.map(row => [row.source, row.target])).toEqual([
      ['jobs', 'jobs'],
      ['subagents', 'subagents'],
      ['plan', 'projections'],
    ])
    expect(snapshot.rows[0]?.label).toContain('bash-1 failed')

    expect(controller.selectedTarget()).toBe('jobs')
    controller.move('down')
    expect(controller.selectedTarget()).toBe('subagents')
    controller.move('down')
    expect(controller.selectedTarget()).toBe('projections')
    controller.move('down')
    expect(controller.selectedTarget()).toBe('jobs') // wraps
    controller.dispose()
  })

  it('coalesces a still-true activity instead of appending duplicates', () => {
    const { controller, subagents } = harness()
    subagents.emit(subagentSnapshot({ unreadCount: 2 }))
    expect(controller.getSnapshot().rows).toHaveLength(1)
    expect(controller.getSnapshot().rows[0]?.count).toBe(1)

    // Three more publishes of the same still-unread state.
    subagents.emit(subagentSnapshot({ unreadCount: 2 }))
    subagents.emit(subagentSnapshot({ unreadCount: 2 }))
    subagents.emit(subagentSnapshot({ unreadCount: 2 }))

    const rows = controller.getSnapshot().rows
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBe(4)
    expect(rows[0]?.label).toContain('×4')
    controller.dispose()
  })

  it('keeps distinct job completions as distinct rows', () => {
    const { controller, jobs } = harness()
    jobs.emit(jobsSnapshot({ notices: [NOTICE('bash-1', 'completed')] }))
    jobs.emit(jobsSnapshot({
      notices: [NOTICE('bash-1', 'completed'), NOTICE('bash-2', 'killed')],
    }))

    const rows = controller.getSnapshot().rows
    expect(rows.map(row => row.key)).toEqual(['jobs:bash-1', 'jobs:bash-2'])
    expect(rows[0]?.count).toBe(2)
    expect(rows[1]?.count).toBe(1)
    controller.dispose()
  })

  it('separates a goal phase change from the previous phase', () => {
    const { controller, projections } = harness()
    const goal = {
      id: 'goal-1',
      maxGoalRounds: 8,
      objective: 'Ship orchestration',
      phase: 'blocked' as const,
      revision: 2,
      roundsStarted: 3,
    }
    projections.emit(projectionSnapshot({ goal: { ...goal, blockedReason: 'needs input' } }))
    projections.emit(projectionSnapshot({ goal: { ...goal, phase: 'complete' } }))

    const rows = controller.getSnapshot().rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ detail: 'needs input' })
    expect(rows[1]?.label).toContain('Goal complete')
    controller.dispose()
  })

  it('ignores goal phases that are not worth interrupting for', () => {
    const { controller, projections } = harness()
    projections.emit(projectionSnapshot({
      goal: {
        id: 'goal-1',
        maxGoalRounds: 8,
        objective: 'Ship orchestration',
        phase: 'active',
        revision: 1,
        roundsStarted: 1,
      },
    }))
    expect(controller.getSnapshot().rows).toHaveLength(0)
    controller.dispose()
  })

  it('acknowledges one notification or all of them', () => {
    const { controller, jobs, subagents } = harness()
    jobs.emit(jobsSnapshot({ notices: [NOTICE('bash-1', 'completed')] }))
    subagents.emit(subagentSnapshot({ unreadCount: 1 }))
    expect(controller.getSnapshot().rows).toHaveLength(2)

    expect(controller.acknowledgeSelected()).toBe(true)
    expect(controller.getSnapshot().rows.map(row => row.key)).toEqual(['subagents:unread'])

    expect(controller.acknowledgeAll()).toBe(true)
    expect(controller.getSnapshot().rows).toHaveLength(0)
    expect(controller.acknowledgeAll()).toBe(false)
    expect(controller.acknowledgeSelected()).toBe(false)
    controller.dispose()
  })

  it('bounds the notification list and counts the overflow', () => {
    const stores = {
      jobs: new FakeStore(jobsSnapshot()),
      projections: new FakeStore(projectionSnapshot()),
      subagents: new FakeStore(subagentSnapshot()),
    }
    const controller = new ActivityCenterController(stores, { maxNotifications: 2 })
    stores.jobs.emit(jobsSnapshot({
      notices: [NOTICE('a', 'completed'), NOTICE('b', 'completed'), NOTICE('c', 'completed')],
    }))

    expect(controller.getSnapshot().rows).toHaveLength(2)
    expect(controller.getSnapshot().droppedNotifications).toBe(1)
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    const stores = {
      jobs: new FakeStore(jobsSnapshot()),
      projections: new FakeStore(projectionSnapshot()),
      subagents: new FakeStore(subagentSnapshot()),
    }
    expect(() => new ActivityCenterController(stores, { maxNotifications: 0 }))
      .toThrow('maxNotifications must be a positive safe integer')
  })

  it('reports a failing source without discarding the center', () => {
    const reportError = vi.fn()
    const stores = {
      jobs: new FakeStore(jobsSnapshot()),
      projections: new FakeStore(projectionSnapshot()),
      subagents: new FakeStore(subagentSnapshot()),
    }
    const controller = new ActivityCenterController(stores, { reportError })
    stores.jobs.getSnapshot = () => {
      throw new Error('jobs panel disposed')
    }

    expect(controller.refresh()).toBe(false)
    expect(reportError).toHaveBeenCalled()
    expect(() => controller.getSnapshot()).not.toThrow()
    controller.dispose()
  })

  it('unsubscribes from every source and never updates after disposal', () => {
    const { controller, jobs, projections, subagents } = harness()
    const listener = vi.fn()
    controller.subscribe(listener)
    const revision = controller.getSnapshot().revision

    controller.dispose()

    expect(jobs.unsubscribes).toBe(1)
    expect(projections.unsubscribes).toBe(1)
    expect(subagents.unsubscribes).toBe(1)

    // A source that keeps publishing after disposal must not move the snapshot.
    jobs.emit(jobsSnapshot({ runningCount: 9 }))
    subagents.emit(subagentSnapshot({ unreadCount: 9 }))
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().revision).toBe(revision)
    expect(() => controller.refresh()).toThrow('ActivityCenterController is disposed')
    controller.dispose()
  })
})
