import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillDefinition, SkillRegistry, SkillSummary } from '@deepseek-ai/dsh-skill'

const DEFAULT_MAX_SKILLS = 500
const DEFAULT_MAX_DETAIL_CODE_UNITS = 4_000
const MAX_TEXT_CODE_UNITS = 500

type Listener = () => void

/**
 * Why hooks are reported rather than listed.
 *
 * Harness rc.6 publishes no hook inventory service: `dsh-base` mounts none, and
 * no package owns one. A hook panel could only be built by inspecting private
 * configuration or by running a hook to see what happens — the first guesses at
 * semantics, and the second has side effects the user did not ask for. So the
 * capability is shown as absent and named, which is a fact, instead of
 * fabricated.
 */
export type HookInventoryState = 'unsupported-no-public-inventory'

export interface SkillRow {
  readonly description: string
  readonly modelInvocable: boolean
  readonly name: string
  readonly provider: string
  readonly source: string
  readonly userInvocable: boolean
  readonly whenToUse?: string
}

export interface SkillDetail {
  readonly content: string
  readonly name: string
  readonly path?: string
  readonly truncated: boolean
}

export interface SkillsSnapshot {
  /** False when a provider did not finish; the rows are usable but partial. */
  readonly complete: boolean
  readonly detail?: SkillDetail
  readonly error?: string
  readonly hooks: HookInventoryState
  readonly query: string
  readonly revision: number
  readonly rows: readonly SkillRow[]
  readonly selectedIndex?: number
  readonly status: 'error' | 'loading' | 'ready' | 'unavailable'
  readonly totalMatches: number
  readonly truncated: boolean
}

export interface SkillsControllerOptions {
  readonly cwd?: () => string
  readonly maxDetailCodeUnits?: number
  readonly maxSkills?: number
  readonly reportError?: (error: unknown) => void
}

type SkillService = Pick<SkillRegistry, 'get' | 'snapshot'>

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
    return '<unrenderable skill discovery failure>'
  }
}

export class SkillsController {
  readonly #agent: Agent | undefined
  readonly #cwd: (() => string) | undefined
  readonly #listeners = new Set<Listener>()
  readonly #maxDetailCodeUnits: number
  readonly #maxSkills: number
  readonly #reportError: (error: unknown) => void
  readonly #service: SkillService | undefined
  #busy = false
  #complete = true
  #detail: SkillDetail | undefined
  #disposed = false
  #error: string | undefined
  #generation = 0
  #pending: AbortController | undefined
  #query = ''
  #revision = 0
  #selectedName: string | undefined
  #skills: readonly SkillRow[] = Object.freeze([])
  #snapshot: SkillsSnapshot
  #totalMatches = 0
  #truncated = false

  constructor(agent?: Agent, service?: SkillService, options: SkillsControllerOptions = {}) {
    this.#agent = agent
    this.#service = service
    this.#cwd = options.cwd
    this.#maxSkills = positiveLimit(options.maxSkills, DEFAULT_MAX_SKILLS, 'maxSkills')
    this.#maxDetailCodeUnits = positiveLimit(
      options.maxDetailCodeUnits,
      DEFAULT_MAX_DETAIL_CODE_UNITS,
      'maxDetailCodeUnits',
    )
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot()
  }

  getSnapshot = (): SkillsSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Re-run discovery. Only the newest run may publish, and an incomplete
   * observation is surfaced as partial rather than cached as authoritative.
   */
  async refresh(): Promise<boolean> {
    this.#assertActive()
    const service = this.#service
    if (service === undefined) return false
    const generation = ++this.#generation
    this.#pending?.abort()
    const controller = new AbortController()
    this.#pending = controller
    this.#busy = true
    this.#publish()
    try {
      const snapshot = await service.snapshot({
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd() }),
        ...(this.#agent === undefined ? {} : { scope: this.#agent }),
        signal: controller.signal,
      })
      if (this.#disposed || generation !== this.#generation) return false
      this.#busy = false
      this.#pending = undefined
      if (!Array.isArray(snapshot.skills)) {
        this.#recordError(new Error('Skill registry returned a non-array catalog'))
        return false
      }
      this.#complete = snapshot.complete === true
      this.#ingest(snapshot.skills)
      this.#error = undefined
      this.#publish()
      return true
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return false
      this.#busy = false
      this.#pending = undefined
      this.#recordError(error)
      return false
    }
  }

  setQuery(query: string): boolean {
    this.#assertActive()
    const next = boundedText(query, 200)
    if (next === this.#query) return false
    this.#query = next
    this.#detail = undefined
    this.#reapply()
    this.#publish()
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#skills.length < 2) return false
    const current = this.#selectedIndex()
    const next = direction === 'down'
      ? (current + 1) % this.#skills.length
      : (current - 1 + this.#skills.length) % this.#skills.length
    this.#selectedName = this.#skills[next]?.name
    this.#detail = undefined
    this.#publish()
    return true
  }

  selected(): SkillRow | undefined {
    this.#assertActive()
    return this.#skills[this.#selectedIndex()]
  }

  /**
   * Load the selected skill's body for reading. Loading a definition is a read;
   * it does not invoke the skill.
   */
  async inspect(): Promise<boolean> {
    this.#assertActive()
    const service = this.#service
    const row = this.selected()
    if (service === undefined || row === undefined) return false
    const generation = this.#generation
    try {
      const definition: SkillDefinition | undefined = await service.get(row.name, {
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd() }),
        ...(this.#agent === undefined ? {} : { scope: this.#agent }),
      })
      if (this.#disposed || generation !== this.#generation) return false
      if (definition === undefined) {
        this.#recordError(new Error(`Skill ${row.name} is no longer loadable`))
        return false
      }
      const content = definition.content
      this.#detail = Object.freeze({
        content: content.slice(0, this.#maxDetailCodeUnits),
        name: definition.name,
        ...(definition.path === undefined ? {} : { path: boundedText(definition.path) }),
        truncated: content.length > this.#maxDetailCodeUnits,
      })
      this.#error = undefined
      this.#publish()
      return true
    } catch (error) {
      if (this.#disposed) return false
      this.#recordError(error)
      return false
    }
  }

  /**
   * The text a user-invocable skill is invoked with. This only produces the
   * composer text; the user still submits it, so nothing is executed on their
   * behalf by opening the panel.
   */
  invocationFor(row: SkillRow | undefined = this.selected()): string | undefined {
    if (row === undefined || !row.userInvocable) return undefined
    return `/${row.name}`
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    const pending = this.#pending
    this.#pending = undefined
    try {
      pending?.abort()
    } catch (error) {
      this.#reportError(error)
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('SkillsController is disposed')
  }

  #all: readonly SkillRow[] = Object.freeze([])

  #ingest(summaries: readonly SkillSummary[]): void {
    this.#all = Object.freeze(summaries.map(summary => Object.freeze({
      description: boundedText(summary.description),
      modelInvocable: summary.invocation.modelInvocable,
      name: boundedText(summary.name, 200),
      provider: boundedText(String(summary.provider), 200),
      source: boundedText(String(summary.source), 200),
      userInvocable: summary.invocation.userInvocable,
      ...(summary.whenToUse === undefined ? {} : { whenToUse: boundedText(summary.whenToUse) }),
    })))
    this.#reapply()
  }

  #reapply(): void {
    const query = this.#query.trim().toLowerCase()
    const matched = query === ''
      ? this.#all
      : this.#all.filter(row => (
          row.name.toLowerCase().includes(query)
          || row.description.toLowerCase().includes(query)
        ))
    this.#totalMatches = matched.length
    this.#truncated = matched.length > this.#maxSkills
    this.#skills = Object.freeze(matched.slice(0, this.#maxSkills))
    const name = this.#selectedName
    if (this.#skills.length === 0) this.#selectedName = undefined
    else if (name === undefined || !this.#skills.some(row => row.name === name)) {
      this.#selectedName = this.#skills[0]?.name
    }
  }

  #selectedIndex(): number {
    const name = this.#selectedName
    if (name === undefined) return 0
    const index = this.#skills.findIndex(row => row.name === name)
    return index < 0 ? 0 : index
  }

  #recordError(error: unknown): void {
    this.#error = errorMessage(error)
    this.#reportError(error)
    this.#publish()
  }

  #publish(): void {
    if (this.#disposed) return
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of [...this.#listeners]) listener()
  }

  #createSnapshot(): SkillsSnapshot {
    const status: SkillsSnapshot['status'] = this.#service === undefined
      ? 'unavailable'
      : this.#error !== undefined
        ? 'error'
        : this.#busy ? 'loading' : 'ready'
    return Object.freeze({
      complete: this.#complete,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      hooks: 'unsupported-no-public-inventory',
      query: this.#query,
      revision: this.#revision,
      rows: this.#skills,
      ...(this.#skills.length === 0 ? {} : { selectedIndex: this.#selectedIndex() }),
      status,
      totalMatches: this.#totalMatches,
      truncated: this.#truncated,
    })
  }
}
