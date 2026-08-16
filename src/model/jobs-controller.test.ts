import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobDoneListener, JobId, JobSnapshot, JobsChangedListener } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { JobsController } from './jobs-controller'

function fakeAgent(id: string): Agent {
  return { id: id as unknown as SessionId } as unknown as Agent
}

function job(overrides: Partial<JobSnapshot> & Pick<JobSnapshot, 'id'>): JobSnapshot {
  return {
    kind: 'bash',
    label: `label ${String(overrides.id)}`,
    reported: false,
    startedAt: 1,
    status: 'running',
    ...overrides,
  } as JobSnapshot
}

const ID = (value: string): JobId => value as unknown as JobId

class FakeJobRegistry {
  readonly get = vi.fn<(id: JobId, caller?: Agent) => JobSnapshot>()
  readonly kill = vi.fn<
    (id: JobId, caller?: Agent, reason?: string) => 'already-finished' | 'requested'
  >(() => 'requested')
  readonly list = vi.fn<(caller?: Agent) => JobSnapshot[]>(() => [])
  changed: JobsChangedListener | undefined
  done: JobDoneListener | undefined
  unsubscribes = 0

  onJobsChanged(listener: JobsChangedListener): () => void {
    this.changed = listener
    return () => {
      this.unsubscribes += 1
      this.changed = undefined
    }
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.done = listener
    return () => {
      this.unsubscribes += 1
      this.done = undefined
    }
  }
}

describe('JobsController (M3.2)', () => {
  it('is unavailable without a registry and never invents job state', () => {
    const controller = new JobsController(fakeAgent('a'))
    expect(controller.getSnapshot()).toMatchObject({
      jobs: [],
      runningCount: 0,
      status: 'unavailable',
    })
    expect(controller.refresh()).toBe(false)
    expect(controller.requestCancel()).toBe(false)
    controller.dispose()
  })

  it('projects owned and unowned jobs with bounded text and a running count', () => {
    const agent = fakeAgent('session-a')
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([
      job({ id: ID('bash-1'), ownerSession: 'session-a' as unknown as SessionId }),
      job({ id: ID('bash-2'), label: 'x'.repeat(1_000) }),
      job({ detail: 'exit code: 0', finishedAt: 9, id: ID('bash-3'), status: 'completed' }),
    ])
    const controller = new JobsController(agent, registry)
    const snapshot = controller.getSnapshot()

    expect(registry.list).toHaveBeenCalledWith(agent)
    expect(snapshot.status).toBe('ready')
    expect(snapshot.runningCount).toBe(2)
    expect(snapshot.jobs[0]).toMatchObject({ id: 'bash-1', owned: true })
    expect(snapshot.jobs[1]?.owned).toBe(false)
    expect(snapshot.jobs[1]?.label).toHaveLength(300)
    expect(snapshot.jobs[2]).toMatchObject({ detail: 'exit code: 0', status: 'completed' })
    expect(snapshot.selectedIndex).toBe(0)
    controller.dispose()
  })

  // The registry's only output seam consumes the read cursor and marks the record
  // reported, which would suppress the owning agent's completion notice.
  it('never consumes job output or admits work as a controller', () => {
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([job({ id: ID('bash-1') })])
    const controller = new JobsController(fakeAgent('a'), registry)

    expect(controller.getSnapshot().outputCapability).toBe('unsupported-consuming-read')
    expect(registry).not.toHaveProperty('readCalled')
    expect('read' in controller).toBe(false)
    expect('attachController' in controller).toBe(false)
    controller.dispose()
  })

  it('refreshes only for its own owner and for unowned jobs', () => {
    const agent = fakeAgent('mine')
    const other = fakeAgent('theirs')
    const registry = new FakeJobRegistry()
    const controller = new JobsController(agent, registry)
    const initial = registry.list.mock.calls.length

    registry.changed?.(other)
    expect(registry.list).toHaveBeenCalledTimes(initial)

    registry.changed?.(undefined)
    registry.changed?.(agent)
    expect(registry.list).toHaveBeenCalledTimes(initial + 2)
    controller.dispose()
  })

  it('anchors selection to a job id across registry churn', () => {
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([job({ id: ID('bash-1') }), job({ id: ID('bash-2') })])
    const controller = new JobsController(fakeAgent('a'), registry)
    controller.move('down')
    expect(controller.getSnapshot().selectedIndex).toBe(1)

    // A job registered before the selection shifts every index.
    registry.list.mockReturnValue([
      job({ id: ID('bash-0') }),
      job({ id: ID('bash-1') }),
      job({ id: ID('bash-2') }),
    ])
    controller.refresh()
    expect(controller.getSnapshot().jobs[controller.getSnapshot().selectedIndex ?? -1]?.id)
      .toBe('bash-2')

    // Losing the anchor falls back to the first row rather than a stale index.
    registry.list.mockReturnValue([job({ id: ID('bash-0') })])
    controller.refresh()
    expect(controller.getSnapshot().selectedIndex).toBe(0)
    controller.dispose()
  })

  it('requires confirmation before killing and refuses settled or foreign jobs', () => {
    const agent = fakeAgent('mine')
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([
      job({ id: ID('bash-1'), ownerSession: 'mine' as unknown as SessionId }),
      job({ id: ID('bash-2'), ownerSession: 'mine' as unknown as SessionId, status: 'completed' }),
      job({ id: ID('bash-3') }),
    ])
    const controller = new JobsController(agent, registry)

    expect(controller.requestCancel()).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      confirmingCancelId: 'bash-1',
      status: 'confirming',
    })
    expect(registry.kill).not.toHaveBeenCalled()

    expect(controller.confirmCancel()).toBe('requested')
    expect(registry.kill).toHaveBeenCalledWith('bash-1', agent, 'cancelled from the TUI job panel')

    controller.move('down')
    expect(controller.requestCancel()).toBe(false) // settled
    controller.move('down')
    expect(controller.requestCancel()).toBe(false) // unowned
    controller.dispose()
  })

  it('drops a confirmation when its job settles or disappears before confirming', () => {
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([job({ id: ID('bash-1'), ownerSession: 'a' as unknown as SessionId })])
    const controller = new JobsController(fakeAgent('a'), registry)
    controller.requestCancel()

    registry.list.mockReturnValue([
      job({ id: ID('bash-1'), ownerSession: 'a' as unknown as SessionId, status: 'completed' }),
    ])
    controller.refresh()

    expect(controller.getSnapshot().confirmingCancelId).toBeUndefined()
    expect(controller.confirmCancel()).toBe('failed')
    expect(registry.kill).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('treats a job that finishes between arming and confirming as a normal race', () => {
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([job({ id: ID('bash-1'), ownerSession: 'a' as unknown as SessionId })])
    registry.kill.mockReturnValue('already-finished')
    const controller = new JobsController(fakeAgent('a'), registry)
    controller.requestCancel()

    expect(controller.confirmCancel()).toBe('already-finished')
    expect(controller.getSnapshot().error).toBeUndefined()
    controller.dispose()
  })

  it('surfaces registry failures without discarding the panel', () => {
    const reportError = vi.fn()
    const registry = new FakeJobRegistry()
    registry.list.mockImplementation(() => {
      throw new Error('registry offline')
    })
    const controller = new JobsController(fakeAgent('a'), registry, { reportError })

    expect(controller.getSnapshot()).toMatchObject({ error: 'registry offline', status: 'error' })
    expect(reportError).toHaveBeenCalled()

    registry.list.mockReturnValue([job({ id: ID('bash-1') })])
    expect(controller.refresh()).toBe(true)
    expect(controller.getSnapshot()).not.toHaveProperty('error')
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('reports a kill failure without claiming the job stopped', () => {
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([job({ id: ID('bash-1'), ownerSession: 'a' as unknown as SessionId })])
    registry.kill.mockImplementation(() => {
      throw new Error('foreign job')
    })
    const controller = new JobsController(fakeAgent('a'), registry)
    controller.requestCancel()

    expect(controller.confirmCancel()).toBe('failed')
    expect(controller.getSnapshot()).toMatchObject({ error: 'foreign job', status: 'error' })
    controller.dispose()
  })

  it('collects bounded completion notices and counts the overflow', () => {
    const agent = fakeAgent('a')
    const registry = new FakeJobRegistry()
    const controller = new JobsController(agent, registry, { maxNotices: 2 })

    registry.done?.(job({ id: ID('bash-1'), status: 'completed' }), agent)
    registry.done?.(job({ id: ID('bash-2'), detail: 'exit code: 3', status: 'failed' }), agent)
    registry.done?.(job({ id: ID('bash-3'), status: 'killed' }), agent)
    registry.done?.(job({ id: ID('bash-4') }), fakeAgent('other'))

    const snapshot = controller.getSnapshot()
    expect(snapshot.notices.map(notice => notice.id)).toEqual(['bash-1', 'bash-2'])
    expect(snapshot.notices[1]).toMatchObject({ detail: 'exit code: 3', status: 'failed' })
    expect(snapshot.droppedNotices).toBe(1)

    expect(controller.acknowledgeNotices()).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ droppedNotices: 0, notices: [] })
    expect(controller.acknowledgeNotices()).toBe(false)
    controller.dispose()
  })

  it('bounds the listing and reports truncation', () => {
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => job({ id: ID(`bash-${index}`) })),
    )
    const controller = new JobsController(fakeAgent('a'), registry, { maxJobs: 3 })
    expect(controller.getSnapshot()).toMatchObject({ truncated: true })
    expect(controller.getSnapshot().jobs).toHaveLength(3)
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    expect(() => new JobsController(fakeAgent('a'), undefined, { maxJobs: 0 }))
      .toThrow('maxJobs must be a positive safe integer')
    expect(() => new JobsController(fakeAgent('a'), undefined, { maxNotices: 1.5 }))
      .toThrow('maxNotices must be a positive safe integer')
  })

  it('unsubscribes on disposal and never updates afterwards', () => {
    const agent = fakeAgent('a')
    const registry = new FakeJobRegistry()
    registry.list.mockReturnValue([job({ id: ID('bash-1') })])
    const controller = new JobsController(agent, registry)
    const listener = vi.fn()
    controller.subscribe(listener)
    const revision = controller.getSnapshot().revision

    controller.dispose()

    expect(registry.unsubscribes).toBe(2)
    expect(registry.changed).toBeUndefined()
    expect(registry.done).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().revision).toBe(revision)
    expect(() => controller.refresh()).toThrow('JobsController is disposed')
    expect(() => controller.requestCancel()).toThrow('JobsController is disposed')
    controller.dispose()
  })

  it('aggregates disposal failures without suppressing teardown', () => {
    const reportError = vi.fn()
    const registry = new FakeJobRegistry()
    const controller = new JobsController(fakeAgent('a'), registry, { reportError })
    registry.onJobsChanged = () => () => {
      throw new Error('unsubscribe failed')
    }

    controller.dispose()
    expect(() => controller.getSnapshot()).not.toThrow()
  })
})
