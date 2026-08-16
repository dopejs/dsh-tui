import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobRegistry, JobSnapshot, JobStatus } from '@deepseek-ai/dsh-jobs'

const DEFAULT_MAX_JOBS = 200
const DEFAULT_MAX_NOTICES = 50
const MAX_LABEL_CODE_UNITS = 300
const MAX_DETAIL_CODE_UNITS = 300

type Listener = () => void

/**
 * Why the job panel never renders live job output on this baseline.
 *
 * `JobRegistry.read()` is the only output seam and it is consuming: it advances
 * the job's single read cursor and marks the record `reported`, which suppresses
 * the model-facing completion notice its owning agent is waiting for. A viewer
 * that tailed output would silently steal work product from the agent loop, so
 * the panel stays on the explicitly non-consuming `get()`/`list()` seams and
 * reports output as unavailable instead of guessing.
 */
export type JobOutputCapability = 'unsupported-consuming-read'

export interface JobRow {
  readonly detail?: string
  readonly finishedAt?: number
  readonly id: JobId
  readonly kind: string
  readonly label: string
  readonly owned: boolean
  readonly reported: boolean
  readonly startedAt: number
  readonly status: JobStatus
}

export interface JobCompletionNotice {
  readonly detail?: string
  readonly finishedAt?: number
  readonly id: JobId
  readonly label: string
  readonly status: JobStatus
}

export interface JobsSnapshot {
  readonly confirmingCancelId?: JobId
  readonly droppedNotices: number
  readonly error?: string
  readonly jobs: readonly JobRow[]
  readonly notices: readonly JobCompletionNotice[]
  readonly outputCapability: JobOutputCapability
  readonly revision: number
  readonly runningCount: number
  readonly selectedIndex?: number
  readonly status: 'confirming' | 'error' | 'ready' | 'unavailable'
  readonly truncated: boolean
}

export interface JobsControllerOptions {
  readonly maxJobs?: number
  readonly maxNotices?: number
  readonly reportError?: (error: unknown) => void
}

/**
 * The registry seams this controller consumes. `read` and `attachController`
 * are deliberately absent: see {@link JobOutputCapability}, and note that
 * attaching a controller would tell the registry this viewer can collect the
 * work it admits, which it cannot.
 */
type JobsService = Pick<JobRegistry, 'get' | 'kill' | 'list' | 'onJobDone' | 'onJobsChanged'>

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function errorMessage(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error)
    return boundedText(value, 500)
  } catch {
    return '<unrenderable job registry failure>'
  }
}

function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export class JobsController {
  readonly #agent: Agent
  readonly #listeners = new Set<Listener>()
  readonly #maxJobs: number
  readonly #maxNotices: number
  readonly #reportError: (error: unknown) => void
  readonly #service: JobsService | undefined
  readonly #stops: (() => void)[] = []
  #confirmingCancelId: JobId | undefined
  #disposed = false
  #droppedNotices = 0
  #error: string | undefined
  #jobs: readonly JobRow[] = Object.freeze([])
  #notices: readonly JobCompletionNotice[] = Object.freeze([])
  #revision = 0
  #selectedId: JobId | undefined
  #snapshot: JobsSnapshot
  #truncated = false

  constructor(agent: Agent, service?: JobsService, options: JobsControllerOptions = {}) {
    this.#agent = agent
    this.#service = service
    this.#maxJobs = positiveLimit(options.maxJobs, DEFAULT_MAX_JOBS, 'maxJobs')
    this.#maxNotices = positiveLimit(options.maxNotices, DEFAULT_MAX_NOTICES, 'maxNotices')
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot()
    if (service === undefined) return
    try {
      this.#stops.push(service.onJobsChanged((owner) => {
        // An `undefined` owner is an unowned job, which changes every visible set.
        if (this.#disposed) return
        if (owner !== undefined && owner !== this.#agent) return
        this.refresh()
      }))
      this.#stops.push(service.onJobDone((snapshot, owner) => {
        if (this.#disposed) return
        if (owner !== undefined && owner !== this.#agent) return
        this.#recordNotice(snapshot)
        this.refresh()
      }))
    } catch (error) {
      this.#recordError(error)
      return
    }
    this.refresh()
  }

  getSnapshot = (): JobsSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  refresh(): boolean {
    this.#assertActive()
    const service = this.#service
    if (service === undefined) return false
    let listed: readonly JobSnapshot[]
    try {
      listed = service.list(this.#agent)
    } catch (error) {
      this.#recordError(error)
      return false
    }
    if (!Array.isArray(listed)) {
      this.#recordError(new Error('Job registry returned a non-array listing'))
      return false
    }
    this.#truncated = listed.length > this.#maxJobs
    this.#jobs = Object.freeze(listed.slice(0, this.#maxJobs).map(job => this.#toRow(job)))
    this.#error = undefined
    this.#reconcileSelection()
    this.#reconcileConfirmation()
    this.#publish()
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#jobs.length < 2) return false
    const current = this.#selectedIndex()
    const next = direction === 'down'
      ? (current + 1) % this.#jobs.length
      : (current - 1 + this.#jobs.length) % this.#jobs.length
    this.#selectedId = this.#jobs[next]?.id
    this.#publish()
    return true
  }

  /**
   * Arm the two-step cancel for the selected job. Refuses jobs that already
   * settled and jobs this session does not own, so a confirmation can never be
   * armed against work the registry would reject.
   */
  requestCancel(): boolean {
    this.#assertActive()
    const selected = this.#selected()
    if (selected === undefined || !selected.owned || isTerminal(selected.status)) return false
    this.#confirmingCancelId = selected.id
    this.#publish()
    return true
  }

  dismissCancel(): boolean {
    this.#assertActive()
    if (this.#confirmingCancelId === undefined) return false
    this.#confirmingCancelId = undefined
    this.#publish()
    return true
  }

  /**
   * Kill the armed job. The registry reports `already-finished` for work that
   * settled between arming and confirming; that is a normal race, not an error.
   */
  confirmCancel(reason = 'cancelled from the TUI job panel'): 'already-finished' | 'failed' | 'requested' {
    this.#assertActive()
    const service = this.#service
    const id = this.#confirmingCancelId
    if (service === undefined || id === undefined) return 'failed'
    this.#confirmingCancelId = undefined
    let outcome: 'already-finished' | 'requested'
    try {
      outcome = service.kill(id, this.#agent, reason)
    } catch (error) {
      this.#recordError(error)
      return 'failed'
    }
    this.refresh()
    return outcome
  }

  acknowledgeNotices(): boolean {
    this.#assertActive()
    if (this.#notices.length === 0 && this.#droppedNotices === 0) return false
    this.#notices = Object.freeze([])
    this.#droppedNotices = 0
    this.#publish()
    return true
  }

  /**
   * Re-read one job through the explicitly non-consuming `get()` seam. Used to
   * refresh a focused row without disturbing its read cursor or notice state.
   */
  inspect(id: JobId): JobRow | undefined {
    this.#assertActive()
    const service = this.#service
    if (service === undefined) return undefined
    try {
      return this.#toRow(service.get(id, this.#agent))
    } catch (error) {
      this.#recordError(error)
      return undefined
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    const stops = this.#stops.splice(0, this.#stops.length)
    const failures: unknown[] = []
    for (const stop of stops.reverse()) {
      try {
        stop()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const failure of failures) this.#reportError(failure)
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('JobsController is disposed')
  }

  #toRow(job: JobSnapshot): JobRow {
    return Object.freeze({
      ...(job.detail === undefined ? {} : { detail: boundedText(job.detail, MAX_DETAIL_CODE_UNITS) }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      id: job.id,
      kind: boundedText(String(job.kind), MAX_LABEL_CODE_UNITS),
      label: boundedText(job.label, MAX_LABEL_CODE_UNITS),
      owned: job.ownerSession !== undefined && job.ownerSession === this.#agent.id,
      reported: job.reported,
      startedAt: job.startedAt,
      status: job.status,
    })
  }

  #recordNotice(job: JobSnapshot): void {
    if (this.#notices.length >= this.#maxNotices) {
      this.#droppedNotices += 1
      return
    }
    this.#notices = Object.freeze([...this.#notices, Object.freeze({
      ...(job.detail === undefined ? {} : { detail: boundedText(job.detail, MAX_DETAIL_CODE_UNITS) }),
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      id: job.id,
      label: boundedText(job.label, MAX_LABEL_CODE_UNITS),
      status: job.status,
    })])
  }

  #recordError(error: unknown): void {
    this.#error = errorMessage(error)
    this.#reportError(error)
    this.#publish()
  }

  #selectedIndex(): number {
    const id = this.#selectedId
    if (id === undefined) return 0
    const index = this.#jobs.findIndex(job => job.id === id)
    return index < 0 ? 0 : index
  }

  #selected(): JobRow | undefined {
    return this.#jobs[this.#selectedIndex()]
  }

  /** Selection is anchored to a job id so registry churn cannot silently retarget it. */
  #reconcileSelection(): void {
    if (this.#jobs.length === 0) {
      this.#selectedId = undefined
      return
    }
    const id = this.#selectedId
    if (id === undefined || !this.#jobs.some(job => job.id === id)) {
      this.#selectedId = this.#jobs[0]?.id
    }
  }

  /** A confirmation cannot survive its job disappearing or settling. */
  #reconcileConfirmation(): void {
    const id = this.#confirmingCancelId
    if (id === undefined) return
    const job = this.#jobs.find(candidate => candidate.id === id)
    if (job === undefined || isTerminal(job.status)) this.#confirmingCancelId = undefined
  }

  #publish(): void {
    if (this.#disposed) return
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of [...this.#listeners]) listener()
  }

  #createSnapshot(): JobsSnapshot {
    const status: JobsSnapshot['status'] = this.#service === undefined
      ? 'unavailable'
      : this.#error !== undefined
        ? 'error'
        : this.#confirmingCancelId !== undefined
          ? 'confirming'
          : 'ready'
    return Object.freeze({
      ...(this.#confirmingCancelId === undefined ? {} : { confirmingCancelId: this.#confirmingCancelId }),
      droppedNotices: this.#droppedNotices,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      jobs: this.#jobs,
      notices: this.#notices,
      outputCapability: 'unsupported-consuming-read',
      revision: this.#revision,
      runningCount: this.#jobs.filter(job => !isTerminal(job.status)).length,
      ...(this.#jobs.length === 0 ? {} : { selectedIndex: this.#selectedIndex() }),
      status,
      truncated: this.#truncated,
    })
  }
}
