import type { Session } from '@deepseek-ai/dsh-session'
import type {
  ProjectionChangeListener,
  ProjectionSnapshot,
  SessionProjectionMap,
} from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'

import { ProjectionHubController } from './projection-hub-controller'

function fakeSession(label: string): Session {
  return { label } as unknown as Session
}

class FakeProjectionRegistry {
  readonly snapshot = vi.fn<(session: Session) => ProjectionSnapshot>()
  listener: ProjectionChangeListener | undefined
  subscribeCount = 0
  unsubscribeCount = 0

  onChanged(listener: ProjectionChangeListener): () => void {
    this.subscribeCount += 1
    this.listener = listener
    return () => {
      this.unsubscribeCount += 1
      if (this.listener === listener) this.listener = undefined
    }
  }

  emit(
    session: Session,
    key: Extract<keyof SessionProjectionMap, string> = 'plan',
    value: unknown = {},
    seq = 0,
  ): void {
    this.listener?.(session, key, value, seq)
  }
}

function cut(asOfSeq: number, values: Readonly<Record<string, unknown>>): ProjectionSnapshot {
  return { asOfSeq, values } as unknown as ProjectionSnapshot
}

describe('ProjectionHubController (M3.1)', () => {
  it('owns one exact-session subscription and projects immutable known domain views', () => {
    const session = fakeSession('current')
    const other = fakeSession('other')
    const registry = new FakeProjectionRegistry()
    registry.snapshot.mockReturnValue(cut(9, {
      contextBreakdown: { messageTokens: 300, systemTokens: 100, toolsTokens: 200 },
      contextPressure: { contextWindow: 4_096, pressureTokens: 1_000, projectedTokens: 1_200 },
      goal: {
        createdAt: 1,
        goal: {
          id: 'goal-1',
          maxGoalRounds: 8,
          objective: 'Ship the projection hub',
          phase: 'active',
          revision: 2,
        },
        roundsStarted: 3,
        updatedAt: 2,
      },
      permissions: { currentValue: 'safe', options: [] },
      plan: { active: true, pending: false },
      todos: [
        { content: 'Inspect public contracts', status: 'completed' },
        { content: 'Render projection panels', status: 'in_progress' },
      ],
      tokenUsage: {
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        outputTokens: 200,
        uncachedInputTokens: 750,
      },
    }))

    const controller = new ProjectionHubController(session, registry)
    const snapshot = controller.getSnapshot()

    expect(registry.subscribeCount).toBe(1)
    expect(registry.snapshot).toHaveBeenCalledTimes(1)
    expect(snapshot).toMatchObject({
      asOfSeq: 9,
      capabilities: {
        goal: 'available',
        plan: 'available',
        todos: 'available',
        usage: 'available',
      },
      diagnostics: [],
      goal: { objective: 'Ship the projection hub', phase: 'active', roundsStarted: 3 },
      plan: { active: true, pending: false },
      status: 'ready',
      todos: [
        { content: 'Inspect public contracts', status: 'completed' },
        { content: 'Render projection panels', status: 'in_progress' },
      ],
      usage: { contextWindow: 4_096, projectedTokens: 1_200, totalTokens: 1_000 },
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.rows)).toBe(true)
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true)
    expect(Reflect.set(snapshot.capabilities, 'plan', 'invalid')).toBe(false)

    registry.emit(other)
    expect(registry.snapshot).toHaveBeenCalledTimes(1)
    registry.emit(session)
    expect(registry.snapshot).toHaveBeenCalledTimes(2)

    controller.dispose()
    controller.dispose()
    expect(registry.unsubscribeCount).toBe(1)
    registry.emit(session)
    expect(registry.snapshot).toHaveBeenCalledTimes(2)
    expect(() => controller.refresh()).toThrow('disposed')
  })

  it('shows explicit capability absence without synthesizing event-folded state', () => {
    const registry = new FakeProjectionRegistry()
    registry.snapshot.mockReturnValue(cut(-1, {}))
    const controller = new ProjectionHubController(fakeSession('empty'), registry)

    expect(controller.getSnapshot()).toMatchObject({
      asOfSeq: -1,
      capabilities: {
        goal: 'unavailable',
        plan: 'unavailable',
        todos: 'unavailable',
        usage: 'unavailable',
      },
      rows: [
        { label: 'plan projection unavailable' },
        { label: 'todos projection unavailable' },
        { label: 'goal projection unavailable' },
        { label: 'usage projection unavailable' },
      ],
      status: 'ready',
    })

    const unavailable = new ProjectionHubController(fakeSession('missing'))
    expect(unavailable.getSnapshot()).toMatchObject({ status: 'unavailable' })
    expect(unavailable.refresh()).toBe(false)
    unavailable.dispose()
    controller.dispose()
  })

  it('bounds todo retention and unknown or invalid diagnostics', () => {
    const registry = new FakeProjectionRegistry()
    registry.snapshot.mockReturnValue(cut(4, {
      alpha: { nested: { deeper: { secret: 'bounded' } } },
      beta: Array.from({ length: 20 }, (_, index) => index),
      goal: { malformed: true },
      plan: { active: 'yes', pending: false },
      todos: Array.from({ length: 5 }, (_, index) => ({
        content: `todo-${String(index)}-${'x'.repeat(1_200)}`,
        status: 'pending',
      })),
    }))
    const controller = new ProjectionHubController(fakeSession('bounded'), registry, {
      maxDiagnostics: 2,
      maxProjectionKeys: 20,
      maxTodos: 2,
    })
    const snapshot = controller.getSnapshot()

    expect(snapshot.status).toBe('degraded')
    expect(snapshot.todos).toHaveLength(2)
    expect(snapshot.todos?.[0]?.content).toHaveLength(1_000)
    expect(snapshot.droppedTodos).toBe(3)
    expect(snapshot.diagnostics).toHaveLength(2)
    expect(snapshot.droppedDiagnostics).toBe(2)
    expect(snapshot.diagnostics.every(item => item.summary.length <= 500)).toBe(true)
    expect(snapshot.capabilities).toMatchObject({ goal: 'invalid', plan: 'invalid' })
    expect(snapshot.rows.at(-1)?.label).toBe('2 additional projection diagnostics omitted')
    controller.dispose()
  })

  it('retains the last good cut across refresh failure and supports retry', () => {
    const session = fakeSession('retry')
    const registry = new FakeProjectionRegistry()
    const reportError = vi.fn()
    registry.snapshot
      .mockReturnValueOnce(cut(1, { plan: { active: false, pending: false } }))
      .mockImplementationOnce(() => { throw new Error('projection cache unavailable') })
      .mockReturnValueOnce(cut(2, { plan: { active: true, pending: true } }))
    const controller = new ProjectionHubController(session, registry, { reportError })
    const goodRows = controller.getSnapshot().rows

    registry.emit(session)
    expect(controller.getSnapshot()).toMatchObject({
      asOfSeq: 1,
      error: 'projection cache unavailable',
      status: 'error',
    })
    expect(controller.getSnapshot().rows).toBe(goodRows)
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'projection cache unavailable',
    }))

    expect(controller.refresh()).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      asOfSeq: 2,
      plan: { active: true, pending: true },
      status: 'ready',
    })
    expect(controller.getSnapshot().error).toBeUndefined()
    controller.dispose()
  })

  it('contains subscription and disposal failures', () => {
    const reportError = vi.fn()
    const subscriptionFailure = {
      onChanged(): () => void {
        throw new Error('subscribe failed')
      },
      snapshot: vi.fn(() => cut(-1, {})),
    }
    const failed = new ProjectionHubController(fakeSession('failed'), subscriptionFailure, {
      reportError,
    })
    expect(failed.getSnapshot()).toMatchObject({ error: 'subscribe failed', status: 'error' })
    expect(subscriptionFailure.snapshot).not.toHaveBeenCalled()
    failed.dispose()

    const disposalFailure = {
      onChanged(): () => void {
        return () => { throw new Error('unsubscribe failed') }
      },
      snapshot: vi.fn(() => cut(-1, {})),
    }
    const disposing = new ProjectionHubController(fakeSession('disposing'), disposalFailure, {
      reportError,
    })
    expect(() => disposing.dispose()).toThrow('unsubscribe failed')
  })

  it('validates every configured retention bound', () => {
    const session = fakeSession('limits')
    expect(() => new ProjectionHubController(session, undefined, { maxDiagnostics: 0 }))
      .toThrow('maxDiagnostics')
    expect(() => new ProjectionHubController(session, undefined, { maxProjectionKeys: 1.5 }))
      .toThrow('maxProjectionKeys')
    expect(() => new ProjectionHubController(session, undefined, { maxTodos: -1 }))
      .toThrow('maxTodos')
  })
})
