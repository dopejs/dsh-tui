import type { OverlayKind } from './overlay-controller'
import type { JobsSnapshot } from './jobs-controller'
import type { ProjectionHubSnapshot } from './projection-hub-controller'
import type { SubagentTreeSnapshot } from './subagent-tree-controller'

const DEFAULT_MAX_NOTIFICATIONS = 50
const MAX_SUMMARY_CODE_UNITS = 200

type Listener = () => void

export type ActivitySource = 'jobs' | 'plan' | 'subagents'

export interface ActivityNotification {
  /** How many times this same activity re-fired while it stayed unacknowledged. */
  readonly count: number
  readonly detail?: string
  /** Stable identity used for coalescing; repeats update in place. */
  readonly key: string
  readonly source: ActivitySource
  readonly summary: string
  /** The overlay that answers this notification. */
  readonly target: OverlayKind
  readonly tone: 'negative' | 'neutral' | 'positive'
}

export interface ActivityCounts {
  readonly jobsRunning: number
  readonly subagentsUnread: number
  readonly todosOpen: number
}

export interface ActivityRow {
  readonly count: number
  readonly detail?: string
  readonly key: string
  readonly label: string
  readonly source: ActivitySource
  readonly target: OverlayKind
}

export interface ActivityCenterSnapshot {
  readonly counts: ActivityCounts
  readonly droppedNotifications: number
  readonly notifications: readonly ActivityNotification[]
  readonly revision: number
  readonly rows: readonly ActivityRow[]
  readonly selectedIndex?: number
  readonly totalActivity: number
}

export interface ActivityStore<T> {
  getSnapshot(): T
  subscribe(listener: Listener): () => void
}

export interface ActivityCenterSources {
  readonly jobs: ActivityStore<JobsSnapshot>
  readonly projections: ActivityStore<ProjectionHubSnapshot>
  readonly subagents: ActivityStore<SubagentTreeSnapshot>
}

export interface ActivityCenterOptions {
  readonly maxNotifications?: number
  readonly reportError?: (error: unknown) => void
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function boundedText(value: string, maximum = MAX_SUMMARY_CODE_UNITS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

interface DerivedActivity {
  readonly detail?: string
  readonly key: string
  readonly source: ActivitySource
  readonly summary: string
  readonly target: OverlayKind
  readonly tone: ActivityNotification['tone']
}

/**
 * Aggregates the plan, job, and subagent views into one bounded notification
 * list and one set of status counts. It owns no domain state: every value is
 * derived from the three snapshots, so it cannot disagree with the panel a
 * notification navigates to.
 */
export class ActivityCenterController {
  readonly #listeners = new Set<Listener>()
  readonly #maxNotifications: number
  readonly #notifications = new Map<string, ActivityNotification>()
  readonly #reportError: (error: unknown) => void
  readonly #sources: ActivityCenterSources
  readonly #stops: (() => void)[] = []
  #disposed = false
  #droppedNotifications = 0
  #revision = 0
  #selectedKey: string | undefined
  #snapshot: ActivityCenterSnapshot

  constructor(sources: ActivityCenterSources, options: ActivityCenterOptions = {}) {
    this.#sources = sources
    this.#maxNotifications = positiveLimit(
      options.maxNotifications,
      DEFAULT_MAX_NOTIFICATIONS,
      'maxNotifications',
    )
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot(this.#emptyCounts(), Object.freeze([]))
    const observe = () => {
      if (!this.#disposed) this.refresh()
    }
    try {
      this.#stops.push(sources.jobs.subscribe(observe))
      this.#stops.push(sources.projections.subscribe(observe))
      this.#stops.push(sources.subagents.subscribe(observe))
    } catch (error) {
      this.#reportError(error)
    }
    this.refresh()
  }

  getSnapshot = (): ActivityCenterSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Re-derive counts and fold current activity into the coalesced notification
   * map. An activity that is still true re-fires as a count bump rather than a
   * new row, so a steady state cannot flood the list.
   */
  refresh(): boolean {
    this.#assertActive()
    let jobs: JobsSnapshot
    let projections: ProjectionHubSnapshot
    let subagents: SubagentTreeSnapshot
    try {
      jobs = this.#sources.jobs.getSnapshot()
      projections = this.#sources.projections.getSnapshot()
      subagents = this.#sources.subagents.getSnapshot()
    } catch (error) {
      this.#reportError(error)
      return false
    }
    for (const activity of this.#derive(jobs, projections, subagents)) {
      this.#record(activity)
    }
    const counts = Object.freeze({
      jobsRunning: jobs.runningCount,
      subagentsUnread: subagents.unreadCount,
      todosOpen: (projections.todos ?? []).filter(todo => todo.status !== 'completed').length,
    })
    this.#publish(counts, this.#rows())
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    const rows = this.#snapshot.rows
    if (rows.length < 2) return false
    const current = this.#selectedIndex(rows)
    const next = direction === 'down'
      ? (current + 1) % rows.length
      : (current - 1 + rows.length) % rows.length
    this.#selectedKey = rows[next]?.key
    this.#publish(this.#snapshot.counts, rows)
    return true
  }

  /** The overlay that answers the selected notification, for the caller to open. */
  selectedTarget(): OverlayKind | undefined {
    this.#assertActive()
    const rows = this.#snapshot.rows
    return rows[this.#selectedIndex(rows)]?.target
  }

  /** Acknowledge the selected notification only, leaving the rest pending. */
  acknowledgeSelected(): boolean {
    this.#assertActive()
    const rows = this.#snapshot.rows
    const row = rows[this.#selectedIndex(rows)]
    if (row === undefined) return false
    this.#notifications.delete(row.key)
    this.#selectedKey = undefined
    this.#publish(this.#snapshot.counts, this.#rows())
    return true
  }

  acknowledgeAll(): boolean {
    this.#assertActive()
    if (this.#notifications.size === 0 && this.#droppedNotifications === 0) return false
    this.#notifications.clear()
    this.#droppedNotifications = 0
    this.#selectedKey = undefined
    this.#publish(this.#snapshot.counts, this.#rows())
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#notifications.clear()
    const stops = this.#stops.splice(0, this.#stops.length)
    for (const stop of stops.reverse()) {
      try {
        stop()
      } catch (error) {
        this.#reportError(error)
      }
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ActivityCenterController is disposed')
  }

  #emptyCounts(): ActivityCounts {
    return Object.freeze({ jobsRunning: 0, subagentsUnread: 0, todosOpen: 0 })
  }

  #derive(
    jobs: JobsSnapshot,
    projections: ProjectionHubSnapshot,
    subagents: SubagentTreeSnapshot,
  ): readonly DerivedActivity[] {
    const derived: DerivedActivity[] = []
    for (const notice of jobs.notices) {
      derived.push({
        ...(notice.detail === undefined ? {} : { detail: boundedText(notice.detail) }),
        key: `jobs:${String(notice.id)}`,
        source: 'jobs',
        summary: boundedText(`${String(notice.id)} ${notice.status}: ${notice.label}`),
        target: 'jobs',
        tone: notice.status === 'completed'
          ? 'positive'
          : notice.status === 'failed' ? 'negative' : 'neutral',
      })
    }
    if (jobs.droppedNotices > 0) {
      derived.push({
        key: 'jobs:dropped',
        source: 'jobs',
        summary: `${String(jobs.droppedNotices)} further job completions were not retained`,
        target: 'jobs',
        tone: 'neutral',
      })
    }
    if (subagents.unreadCount > 0) {
      derived.push({
        key: 'subagents:unread',
        source: 'subagents',
        summary: `${String(subagents.unreadCount)} subagent updates`,
        target: 'subagents',
        tone: 'neutral',
      })
    }
    const goal = projections.goal
    if (goal != null && (goal.phase === 'blocked' || goal.phase === 'complete')) {
      derived.push({
        ...(goal.blockedReason === undefined ? {} : { detail: boundedText(goal.blockedReason) }),
        key: `plan:goal:${goal.id}:${goal.phase}`,
        source: 'plan',
        summary: boundedText(`Goal ${goal.phase}: ${goal.objective}`),
        target: 'projections',
        tone: goal.phase === 'complete' ? 'positive' : 'negative',
      })
    }
    if (projections.plan?.pending === true) {
      derived.push({
        key: 'plan:pending',
        source: 'plan',
        summary: 'A plan is awaiting review',
        target: 'projections',
        tone: 'neutral',
      })
    }
    return Object.freeze(derived)
  }

  #record(activity: DerivedActivity): void {
    const existing = this.#notifications.get(activity.key)
    if (existing !== undefined) {
      // Same activity still true: coalesce into the existing row.
      this.#notifications.set(activity.key, Object.freeze({ ...activity, count: existing.count + 1 }))
      return
    }
    if (this.#notifications.size >= this.#maxNotifications) {
      this.#droppedNotifications += 1
      return
    }
    this.#notifications.set(activity.key, Object.freeze({ ...activity, count: 1 }))
  }

  #rows(): readonly ActivityRow[] {
    return Object.freeze([...this.#notifications.values()].map(notification => Object.freeze({
      count: notification.count,
      ...(notification.detail === undefined ? {} : { detail: notification.detail }),
      key: notification.key,
      label: notification.count > 1
        ? `${notification.summary} (×${String(notification.count)})`
        : notification.summary,
      source: notification.source,
      target: notification.target,
    })))
  }

  #selectedIndex(rows: readonly ActivityRow[]): number {
    const key = this.#selectedKey
    if (key === undefined) return 0
    const index = rows.findIndex(row => row.key === key)
    return index < 0 ? 0 : index
  }

  #publish(counts: ActivityCounts, rows: readonly ActivityRow[]): void {
    if (this.#disposed) return
    this.#revision += 1
    this.#snapshot = this.#createSnapshot(counts, rows)
    for (const listener of [...this.#listeners]) listener()
  }

  #createSnapshot(counts: ActivityCounts, rows: readonly ActivityRow[]): ActivityCenterSnapshot {
    return Object.freeze({
      counts,
      droppedNotifications: this.#droppedNotifications,
      notifications: Object.freeze([...this.#notifications.values()]),
      revision: this.#revision,
      rows,
      ...(rows.length === 0 ? {} : { selectedIndex: this.#selectedIndex(rows) }),
      totalActivity: counts.jobsRunning + counts.subagentsUnread + rows.length,
    })
  }
}
