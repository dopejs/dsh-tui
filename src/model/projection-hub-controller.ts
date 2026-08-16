import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/client'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type {
  ContextBreakdownProjection,
  ContextPressureProjection,
  TokenUsageProjection,
} from '@deepseek-ai/dsh-token-meter/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'

const DEFAULT_MAX_DIAGNOSTICS = 32
const DEFAULT_MAX_PROJECTION_KEYS = 128
const DEFAULT_MAX_TODOS = 100
const MAX_KEY_CODE_UNITS = 100
const MAX_TEXT_CODE_UNITS = 1_000
const MAX_UNKNOWN_SUMMARY_CODE_UNITS = 500

type Listener = () => void

export type ProjectionCapabilityState = 'available' | 'invalid' | 'unavailable'
export type ProjectionSection = 'diagnostics' | 'goal' | 'plan' | 'todos' | 'usage'

export interface ProjectionCapabilities {
  readonly goal: ProjectionCapabilityState
  readonly plan: ProjectionCapabilityState
  readonly todos: ProjectionCapabilityState
  readonly usage: ProjectionCapabilityState
}

export interface ProjectionDiagnostic {
  readonly key: string
  readonly kind: 'invalid' | 'unknown'
  readonly summary: string
}

export interface ProjectionDisplayRow {
  readonly detail?: string
  readonly id: string
  readonly label: string
  readonly section: ProjectionSection
  readonly tone?: 'dim' | 'negative' | 'positive' | 'warning'
}

export interface ProjectionGoalSummary {
  readonly blockedReason?: string
  readonly id: string
  readonly maxGoalRounds: number
  readonly objective: string
  readonly phase: 'active' | 'blocked' | 'complete' | 'paused'
  readonly revision: number
  readonly roundsStarted: number
}

export interface ProjectionPlanSummary {
  readonly active: boolean
  readonly pending: boolean
}

export interface ProjectionTodoSummary {
  readonly content: string
  readonly status: TodoItem['status']
}

export interface ProjectionUsageSummary {
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly contextWindow?: number
  readonly messageTokens?: number
  readonly outputTokens?: number
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly systemTokens?: number
  readonly toolsTokens?: number
  readonly totalTokens?: number
  readonly uncachedInputTokens?: number
}

export interface ProjectionHubSnapshot {
  readonly asOfSeq?: number
  readonly capabilities: ProjectionCapabilities
  readonly diagnostics: readonly ProjectionDiagnostic[]
  readonly droppedDiagnostics: number
  readonly droppedTodos: number
  readonly error?: string
  readonly goal?: ProjectionGoalSummary | null
  readonly plan?: ProjectionPlanSummary
  readonly revision: number
  readonly rows: readonly ProjectionDisplayRow[]
  readonly selectedIndex?: number
  readonly status: 'degraded' | 'error' | 'ready' | 'unavailable'
  readonly todos?: readonly ProjectionTodoSummary[] | null
  readonly usage?: ProjectionUsageSummary
}

export interface ProjectionHubOptions {
  readonly maxDiagnostics?: number
  readonly maxProjectionKeys?: number
  readonly maxTodos?: number
  readonly reportError?: (error: unknown) => void
}

type ProjectionRegistry = Pick<SessionProjectionRegistry, 'onChanged' | 'snapshot'>

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function boundedText(value: string, maximum = MAX_TEXT_CODE_UNITS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function errorMessage(error: unknown): string {
  try {
    return boundedText(error instanceof Error ? error.message : String(error), 500)
  } catch {
    return '<unrenderable projection failure>'
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value)
}

function isPlanProjection(value: unknown): value is PlanProjection {
  return isRecord(value) && typeof value.active === 'boolean' && typeof value.pending === 'boolean'
}

function isTodoItem(value: unknown): value is TodoItem {
  return isRecord(value)
    && typeof value.content === 'string'
    && (value.status === 'pending' || value.status === 'in_progress' || value.status === 'completed')
}

function isTodoProjection(value: unknown): value is readonly TodoItem[] | null {
  return value === null || (Array.isArray(value) && value.every(isTodoItem))
}

function isGoalProjection(value: unknown): value is GoalProjection | null {
  if (value === null) return true
  if (!isRecord(value) || !isRecord(value.goal)) return false
  const goal = value.goal
  const validPhase = goal.phase === 'active'
    || goal.phase === 'paused'
    || goal.phase === 'blocked'
    || goal.phase === 'complete'
  const validBlockedReason = goal.blockedReason === undefined
    || (isRecord(goal.blockedReason)
      && typeof goal.blockedReason.code === 'string'
      && typeof goal.blockedReason.message === 'string')
  return typeof goal.id === 'string'
    && isNonNegativeInteger(goal.revision)
    && goal.revision > 0
    && typeof goal.objective === 'string'
    && validPhase
    && validBlockedReason
    && isNonNegativeInteger(goal.maxGoalRounds)
    && isNonNegativeInteger(value.roundsStarted)
    && isNonNegativeInteger(value.createdAt)
    && isNonNegativeInteger(value.updatedAt)
}

function isTokenUsage(value: unknown): value is TokenUsageProjection {
  return isRecord(value)
    && isNonNegativeInteger(value.uncachedInputTokens)
    && isNonNegativeInteger(value.outputTokens)
    && isNonNegativeInteger(value.cacheReadTokens)
    && isNonNegativeInteger(value.cacheWriteTokens)
}

function isContextPressure(value: unknown): value is ContextPressureProjection {
  return isRecord(value)
    && optionalNonNegativeInteger(value.pressureTokens)
    && optionalNonNegativeInteger(value.projectedTokens)
    && optionalNonNegativeInteger(value.contextWindow)
}

function isContextBreakdown(value: unknown): value is ContextBreakdownProjection {
  return isRecord(value)
    && isNonNegativeInteger(value.systemTokens)
    && isNonNegativeInteger(value.toolsTokens)
    && isNonNegativeInteger(value.messageTokens)
}

function boundedSum(values: readonly number[]): number {
  return values.reduce(
    (total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value),
    0,
  )
}

function summarizeUnknown(value: unknown): string {
  const seen = new WeakSet<object>()
  const render = (current: unknown, depth: number): string => {
    if (current === null) return 'null'
    if (typeof current === 'string') return JSON.stringify(boundedText(current, 120))
    if (typeof current === 'number' || typeof current === 'boolean') return String(current)
    if (typeof current === 'undefined') return 'undefined'
    if (typeof current === 'bigint') return `${String(current)}n`
    if (typeof current === 'symbol') return current.description === undefined ? 'Symbol()' : `Symbol(${current.description})`
    if (typeof current === 'function') return '[function]'
    if (typeof current !== 'object') return '<unknown>'
    if (seen.has(current)) return '[circular]'
    if (depth >= 3) return Array.isArray(current) ? '[…]' : '{…}'
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        const items = current.slice(0, 8).map(item => render(item, depth + 1))
        return `[${items.join(', ')}${current.length > items.length ? ', …' : ''}]`
      }
      let keys: string[]
      try {
        keys = Object.keys(current).sort().slice(0, 8)
      } catch {
        return '{<uninspectable>}'
      }
      const fields = keys.map((key) => {
        try {
          return `${JSON.stringify(boundedText(key, 60))}: ${render(Reflect.get(current, key), depth + 1)}`
        } catch {
          return `${JSON.stringify(boundedText(key, 60))}: <unreadable>`
        }
      })
      let totalKeys = keys.length
      try {
        totalKeys = Object.keys(current).length
      } catch {
        // The inspected prefix is still useful.
      }
      return `{${fields.join(', ')}${totalKeys > keys.length ? ', …' : ''}}`
    } finally {
      seen.delete(current)
    }
  }
  try {
    return boundedText(render(value, 0), MAX_UNKNOWN_SUMMARY_CODE_UNITS)
  } catch {
    return '<unrenderable projection value>'
  }
}

function capabilityRow(
  section: Exclude<ProjectionSection, 'diagnostics'>,
  state: ProjectionCapabilityState,
): ProjectionDisplayRow | undefined {
  if (state === 'available') return undefined
  return Object.freeze({
    id: `${section}:${state}`,
    label: `${section} projection ${state}`,
    section,
    tone: state === 'invalid' ? 'negative' : 'dim',
  })
}

function todoTone(status: TodoItem['status']): NonNullable<ProjectionDisplayRow['tone']> {
  if (status === 'completed') return 'positive'
  if (status === 'in_progress') return 'warning'
  return 'dim'
}

function goalTone(phase: ProjectionGoalSummary['phase']): NonNullable<ProjectionDisplayRow['tone']> {
  if (phase === 'complete') return 'positive'
  if (phase === 'blocked') return 'negative'
  if (phase === 'active') return 'warning'
  return 'dim'
}

export class ProjectionHubController {
  readonly #listeners = new Set<Listener>()
  readonly #maxDiagnostics: number
  readonly #maxProjectionKeys: number
  readonly #maxTodos: number
  readonly #registry: ProjectionRegistry | undefined
  readonly #reportError: (error: unknown) => void
  readonly #session: Session
  #disposed = false
  #revision = 0
  #selectedIndex = 0
  #snapshot: ProjectionHubSnapshot
  #stop: (() => void) | undefined

  constructor(
    session: Session,
    registry?: ProjectionRegistry,
    options: ProjectionHubOptions = {},
  ) {
    this.#session = session
    this.#registry = registry
    this.#maxDiagnostics = positiveLimit(
      options.maxDiagnostics,
      DEFAULT_MAX_DIAGNOSTICS,
      'maxDiagnostics',
    )
    this.#maxProjectionKeys = positiveLimit(
      options.maxProjectionKeys,
      DEFAULT_MAX_PROJECTION_KEYS,
      'maxProjectionKeys',
    )
    this.#maxTodos = positiveLimit(options.maxTodos, DEFAULT_MAX_TODOS, 'maxTodos')
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#unavailableSnapshot()
    if (registry !== undefined) {
      try {
        this.#stop = registry.onChanged((changedSession) => {
          if (this.#disposed || changedSession !== this.#session) return
          this.refresh()
        })
      } catch (error) {
        this.#recordRefreshError(error)
        return
      }
      this.refresh()
    }
  }

  getSnapshot = (): ProjectionHubSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#snapshot.rows.length < 2) return false
    this.#selectedIndex = direction === 'down'
      ? (this.#selectedIndex + 1) % this.#snapshot.rows.length
      : (this.#selectedIndex - 1 + this.#snapshot.rows.length) % this.#snapshot.rows.length
    this.#publish({ ...this.#snapshot, selectedIndex: this.#selectedIndex })
    return true
  }

  refresh(): boolean {
    this.#assertActive()
    const registry = this.#registry
    if (registry === undefined) return false
    try {
      const cut = registry.snapshot(this.#session)
      if (!Number.isSafeInteger(cut.asOfSeq) || cut.asOfSeq < -1 || !isRecord(cut.values)) {
        throw new Error('Projection registry returned an invalid consistency cut')
      }
      this.#publish(this.#project(cut.asOfSeq, cut.values))
      return true
    } catch (error) {
      this.#recordRefreshError(error)
      return false
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const stop = this.#stop
    this.#stop = undefined
    this.#listeners.clear()
    stop?.()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ProjectionHubController is disposed')
  }

  #project(asOfSeq: number, values: Readonly<Record<string, unknown>>): ProjectionHubSnapshot {
    const allKeys = Object.keys(values).sort()
    const priorityKeys = [
      'plan',
      'todos',
      'goal',
      'tokenUsage',
      'contextPressure',
      'contextBreakdown',
      'permissions',
    ].filter(key => Object.hasOwn(values, key))
    const prioritySet = new Set(priorityKeys)
    const keys = [
      ...priorityKeys,
      ...allKeys.filter(key => !prioritySet.has(key)),
    ].slice(0, this.#maxProjectionKeys)
    const diagnostics: ProjectionDiagnostic[] = []
    let droppedDiagnostics = Math.max(0, allKeys.length - keys.length)
    const addDiagnostic = (diagnostic: ProjectionDiagnostic) => {
      if (diagnostics.length >= this.#maxDiagnostics) {
        droppedDiagnostics += 1
        return
      }
      diagnostics.push(Object.freeze(diagnostic))
    }
    let plan: ProjectionPlanSummary | undefined
    let todos: readonly ProjectionTodoSummary[] | null | undefined
    let goal: ProjectionGoalSummary | null | undefined
    const usage: {
      breakdown?: ContextBreakdownProjection
      pressure?: ContextPressureProjection
      tokens?: TokenUsageProjection
    } = {}
    const capabilities: { goal: ProjectionCapabilityState, plan: ProjectionCapabilityState, todos: ProjectionCapabilityState, usage: ProjectionCapabilityState } = {
      goal: 'unavailable',
      plan: 'unavailable',
      todos: 'unavailable',
      usage: 'unavailable',
    }

    for (const key of keys) {
      const value = values[key]
      if (key === 'plan') {
        if (isPlanProjection(value)) {
          plan = Object.freeze({ active: value.active, pending: value.pending })
          capabilities.plan = 'available'
        } else {
          capabilities.plan = 'invalid'
          addDiagnostic({ key, kind: 'invalid', summary: summarizeUnknown(value) })
        }
      } else if (key === 'todos') {
        if (isTodoProjection(value)) {
          if (value === null) {
            todos = null
          } else {
            todos = Object.freeze(value.slice(0, this.#maxTodos).map(item => Object.freeze({
              content: boundedText(item.content),
              status: item.status,
            })))
          }
          capabilities.todos = 'available'
        } else {
          capabilities.todos = 'invalid'
          addDiagnostic({ key, kind: 'invalid', summary: summarizeUnknown(value) })
        }
      } else if (key === 'goal') {
        if (isGoalProjection(value)) {
          if (value === null) {
            goal = null
          } else {
            goal = Object.freeze({
              ...(value.goal.blockedReason === undefined
                ? {}
                : { blockedReason: boundedText(value.goal.blockedReason.message) }),
              id: boundedText(String(value.goal.id), 200),
              maxGoalRounds: value.goal.maxGoalRounds,
              objective: boundedText(value.goal.objective),
              phase: value.goal.phase,
              revision: value.goal.revision,
              roundsStarted: value.roundsStarted,
            })
          }
          capabilities.goal = 'available'
        } else {
          capabilities.goal = 'invalid'
          addDiagnostic({ key, kind: 'invalid', summary: summarizeUnknown(value) })
        }
      } else if (key === 'tokenUsage') {
        if (isTokenUsage(value)) usage.tokens = value
        else addDiagnostic({ key, kind: 'invalid', summary: summarizeUnknown(value) })
      } else if (key === 'contextPressure') {
        if (isContextPressure(value)) usage.pressure = value
        else addDiagnostic({ key, kind: 'invalid', summary: summarizeUnknown(value) })
      } else if (key === 'contextBreakdown') {
        if (isContextBreakdown(value)) usage.breakdown = value
        else addDiagnostic({ key, kind: 'invalid', summary: summarizeUnknown(value) })
      } else if (key !== 'permissions') {
        addDiagnostic({
          key: boundedText(key, MAX_KEY_CODE_UNITS),
          kind: 'unknown',
          summary: summarizeUnknown(value),
        })
      }
    }

    const usageKeys: readonly string[] = keys.filter(
      key => key === 'tokenUsage' || key === 'contextPressure' || key === 'contextBreakdown',
    )
    let usageSummary: ProjectionUsageSummary | undefined
    if (usageKeys.length > 0) {
      const invalidUsageCount = diagnostics.filter(
        diagnostic => diagnostic.kind === 'invalid' && usageKeys.includes(diagnostic.key),
      ).length
      capabilities.usage = invalidUsageCount === usageKeys.length ? 'invalid' : 'available'
      if (usage.tokens !== undefined || usage.pressure !== undefined || usage.breakdown !== undefined) {
        usageSummary = Object.freeze({
          ...(usage.tokens === undefined
            ? {}
            : {
                cacheReadTokens: usage.tokens.cacheReadTokens,
                cacheWriteTokens: usage.tokens.cacheWriteTokens,
                outputTokens: usage.tokens.outputTokens,
                totalTokens: boundedSum([
                  usage.tokens.uncachedInputTokens,
                  usage.tokens.outputTokens,
                  usage.tokens.cacheReadTokens,
                  usage.tokens.cacheWriteTokens,
                ]),
                uncachedInputTokens: usage.tokens.uncachedInputTokens,
              }),
          ...(usage.pressure === undefined ? {} : usage.pressure),
          ...(usage.breakdown === undefined ? {} : usage.breakdown),
        })
      }
    }

    const projectedTodos = Array.isArray(todos) ? todos : undefined
    const droppedTodos = values.todos !== null && Array.isArray(values.todos)
      ? Math.max(0, values.todos.length - (projectedTodos?.length ?? 0))
      : 0
    const frozenCapabilities = Object.freeze({ ...capabilities })
    const frozenDiagnostics = Object.freeze(diagnostics)
    const rows = this.#rows(
      frozenCapabilities,
      plan,
      todos,
      goal,
      usageSummary,
      frozenDiagnostics,
      droppedTodos,
      droppedDiagnostics,
    )
    this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, rows.length - 1))
    return Object.freeze({
      asOfSeq,
      capabilities: frozenCapabilities,
      diagnostics: frozenDiagnostics,
      droppedDiagnostics,
      droppedTodos,
      ...(goal === undefined ? {} : { goal }),
      ...(plan === undefined ? {} : { plan }),
      revision: this.#revision + 1,
      rows,
      ...(rows.length === 0 ? {} : { selectedIndex: this.#selectedIndex }),
      status: diagnostics.length > 0 || droppedDiagnostics > 0 ? 'degraded' : 'ready',
      ...(todos === undefined ? {} : { todos }),
      ...(usageSummary === undefined ? {} : { usage: usageSummary }),
    })
  }

  #rows(
    capabilities: ProjectionCapabilities,
    plan: ProjectionPlanSummary | undefined,
    todos: readonly ProjectionTodoSummary[] | null | undefined,
    goal: ProjectionGoalSummary | null | undefined,
    usage: ProjectionUsageSummary | undefined,
    diagnostics: readonly ProjectionDiagnostic[],
    droppedTodos: number,
    droppedDiagnostics: number,
  ): readonly ProjectionDisplayRow[] {
    const rows: ProjectionDisplayRow[] = []
    const planFallback = capabilityRow('plan', capabilities.plan)
    if (planFallback !== undefined) rows.push(planFallback)
    else if (plan !== undefined) rows.push(Object.freeze({
      id: 'plan:current',
      label: `Plan · ${plan.active ? 'active' : 'inactive'}${plan.pending ? ' · transition pending' : ''}`,
      section: 'plan',
      tone: plan.pending ? 'warning' : plan.active ? 'positive' : 'dim',
    }))

    const todosFallback = capabilityRow('todos', capabilities.todos)
    if (todosFallback !== undefined) rows.push(todosFallback)
    else if (todos === null) rows.push(Object.freeze({
      id: 'todos:empty', label: 'Todos · no snapshot yet', section: 'todos', tone: 'dim',
    }))
    else if (todos?.length === 0) rows.push(Object.freeze({
      id: 'todos:empty', label: 'Todos · empty', section: 'todos', tone: 'positive',
    }))
    else todos?.forEach((todo, index) => rows.push(Object.freeze({
      id: `todos:${String(index)}`,
      label: `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'} ${todo.content}`,
      section: 'todos',
      tone: todoTone(todo.status),
    })))
    if (droppedTodos > 0) rows.push(Object.freeze({
      id: 'todos:truncated',
      label: `Todos · ${String(droppedTodos)} additional items omitted`,
      section: 'todos',
      tone: 'warning',
    }))

    const goalFallback = capabilityRow('goal', capabilities.goal)
    if (goalFallback !== undefined) rows.push(goalFallback)
    else if (goal === null) rows.push(Object.freeze({
      id: 'goal:empty', label: 'Goal · none active', section: 'goal', tone: 'dim',
    }))
    else if (goal !== undefined) rows.push(Object.freeze({
      ...(goal.blockedReason === undefined
        ? { detail: `rounds ${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)} · revision ${String(goal.revision)}` }
        : { detail: `${goal.blockedReason} · rounds ${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)}` }),
      id: 'goal:current',
      label: `Goal · ${goal.phase} · ${goal.objective}`,
      section: 'goal',
      tone: goalTone(goal.phase),
    }))

    const usageFallback = capabilityRow('usage', capabilities.usage)
    if (usageFallback !== undefined) rows.push(usageFallback)
    else if (usage !== undefined) {
      if (usage.totalTokens !== undefined) rows.push(Object.freeze({
        detail: `input ${String(usage.uncachedInputTokens ?? 0)} · output ${String(usage.outputTokens ?? 0)} · cache read ${String(usage.cacheReadTokens ?? 0)} · write ${String(usage.cacheWriteTokens ?? 0)}`,
        id: 'usage:tokens',
        label: `Usage · ${String(usage.totalTokens)} cumulative tokens`,
        section: 'usage',
      }))
      if (usage.pressureTokens !== undefined || usage.projectedTokens !== undefined || usage.contextWindow !== undefined) {
        rows.push(Object.freeze({
          id: 'usage:pressure',
          label: `Context · observed ${String(usage.pressureTokens ?? '—')} · projected ${String(usage.projectedTokens ?? '—')} / ${String(usage.contextWindow ?? '—')}`,
          section: 'usage',
        }))
      }
      if (usage.systemTokens !== undefined || usage.toolsTokens !== undefined || usage.messageTokens !== undefined) {
        rows.push(Object.freeze({
          id: 'usage:breakdown',
          label: `Composition ≈ system ${String(usage.systemTokens ?? 0)} · tools ${String(usage.toolsTokens ?? 0)} · messages ${String(usage.messageTokens ?? 0)}`,
          section: 'usage',
          tone: 'dim',
        }))
      }
    }

    for (const diagnostic of diagnostics) rows.push(Object.freeze({
      detail: diagnostic.summary,
      id: `diagnostic:${diagnostic.kind}:${diagnostic.key}`,
      label: `${diagnostic.kind === 'invalid' ? 'Invalid' : 'Unknown'} projection · ${diagnostic.key}`,
      section: 'diagnostics',
      tone: diagnostic.kind === 'invalid' ? 'negative' : 'warning',
    }))
    if (droppedDiagnostics > 0) rows.push(Object.freeze({
      id: 'diagnostics:truncated',
      label: `${String(droppedDiagnostics)} additional projection diagnostics omitted`,
      section: 'diagnostics',
      tone: 'warning',
    }))
    return Object.freeze(rows)
  }

  #unavailableSnapshot(): ProjectionHubSnapshot {
    const capabilities = Object.freeze({
      goal: 'unavailable' as const,
      plan: 'unavailable' as const,
      todos: 'unavailable' as const,
      usage: 'unavailable' as const,
    })
    const rows = this.#rows(capabilities, undefined, undefined, undefined, undefined, [], 0, 0)
    return Object.freeze({
      capabilities,
      diagnostics: Object.freeze([]),
      droppedDiagnostics: 0,
      droppedTodos: 0,
      revision: this.#revision,
      rows,
      selectedIndex: 0,
      status: 'unavailable',
    })
  }

  #recordRefreshError(error: unknown): void {
    this.#reportError(error)
    this.#publish({
      ...this.#snapshot,
      error: errorMessage(error),
      revision: this.#revision + 1,
      status: 'error',
    })
  }

  #publish(next: ProjectionHubSnapshot): void {
    this.#revision += 1
    this.#snapshot = Object.freeze({ ...next, revision: this.#revision })
    for (const listener of this.#listeners) listener()
  }
}
