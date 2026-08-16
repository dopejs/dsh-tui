import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry, SubagentRuntime } from '@deepseek-ai/dsh-subagent'

const DEFAULT_MAX_ROWS = 500
const MAX_LABEL_CODE_UNITS = 200
const MAX_FOLLOWUP_CODE_UNITS = 10_000

type Listener = () => void

export type SubagentActivity = 'inactive' | 'running'
export type SubagentMode = 'continuable' | 'one-shot'
export type SubagentDiagnosticReason = 'corrupt' | 'unavailable' | 'unsupported'

export interface SubagentRow {
  readonly activity?: SubagentActivity
  readonly depth: number
  readonly hasChildren?: boolean
  readonly id: SessionId
  readonly kind: 'child' | 'diagnostic'
  readonly label?: string
  readonly mode?: SubagentMode
  readonly parentId: SessionId
  readonly reason?: SubagentDiagnosticReason
  readonly unread: boolean
}

export interface SubagentTreeSnapshot {
  readonly busy: boolean
  readonly error?: string
  readonly followupText: string
  readonly revision: number
  readonly rootSessionId: SessionId
  readonly rows: readonly SubagentRow[]
  readonly selectedIndex?: number
  readonly status: 'error' | 'followup-input' | 'loading' | 'ready' | 'unavailable'
  readonly truncated: boolean
  readonly unreadCount: number
}

export interface SubagentTreeOptions {
  readonly attach?: (childId: SessionId) => void
  readonly maxRows?: number
  readonly reportError?: (error: unknown) => void
}

/**
 * The runtime seams this controller consumes. Enumeration loads and resumes no
 * Agent, `interrupt` is a fire-and-return signal, and `followup` requires the
 * exact live direct parent — which this session only is for its own direct
 * children.
 */
type SubagentService = Pick<SubagentRuntime, 'followup' | 'interrupt' | 'listDescendants'>

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
    return boundedText(error instanceof Error ? error.message : String(error), 500)
  } catch {
    return '<unrenderable subagent failure>'
  }
}

/**
 * The comparable facts of one row. A change in any of them is what marks a row
 * unread, so an unchanged tree re-listed on a timer never accumulates noise.
 */
function signatureOf(entry: SubagentDescendantListEntry): string {
  return entry.kind === 'diagnostic'
    ? `diagnostic:${entry.reason}`
    : `child:${entry.activity}:${entry.mode}:${entry.mode === 'continuable' ? entry.label : entry.label ?? ''}`
}

export class SubagentTreeController {
  readonly #agent: Agent
  readonly #attach: ((childId: SessionId) => void) | undefined
  readonly #listeners = new Set<Listener>()
  readonly #maxRows: number
  readonly #reportError: (error: unknown) => void
  readonly #service: SubagentService | undefined
  readonly #signatures = new Map<string, string>()
  #busy = false
  #composingFollowupFor: SessionId | undefined
  #disposed = false
  #error: string | undefined
  #followupText = ''
  #generation = 0
  #pending: AbortController | undefined
  #revision = 0
  #rootSessionId: SessionId
  #rows: readonly SubagentRow[] = Object.freeze([])
  #selectedId: SessionId | undefined
  #snapshot: SubagentTreeSnapshot
  #truncated = false

  constructor(agent: Agent, service?: SubagentService, options: SubagentTreeOptions = {}) {
    this.#agent = agent
    this.#service = service
    this.#rootSessionId = agent.id
    this.#attach = options.attach
    this.#maxRows = positiveLimit(options.maxRows, DEFAULT_MAX_ROWS, 'maxRows')
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot()
  }

  getSnapshot = (): SubagentTreeSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Re-enumerate the tree. Only the newest listing may publish: an earlier one
   * that resolves late is discarded rather than overwriting fresher rows.
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
    let entries: readonly SubagentDescendantListEntry[]
    try {
      entries = await service.listDescendants(this.#rootSessionId, controller.signal)
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return false
      this.#busy = false
      this.#pending = undefined
      this.#recordError(error)
      return false
    }
    if (this.#disposed || generation !== this.#generation) return false
    this.#busy = false
    this.#pending = undefined
    if (!Array.isArray(entries)) {
      this.#recordError(new Error('Subagent runtime returned a non-array listing'))
      return false
    }
    this.#truncated = entries.length > this.#maxRows
    this.#rows = Object.freeze(entries.slice(0, this.#maxRows).map(entry => this.#toRow(entry)))
    this.#pruneSignatures()
    this.#error = undefined
    this.#reconcileSelection()
    this.#reconcileFollowup()
    this.#publish()
    return true
  }

  /**
   * Point the tree at a different root. Pending work for the previous root is
   * abandoned and unread state is dropped, because it described another tree.
   */
  setRoot(rootSessionId: SessionId): boolean {
    this.#assertActive()
    if (rootSessionId === this.#rootSessionId) return false
    this.#generation += 1
    this.#pending?.abort()
    this.#pending = undefined
    this.#busy = false
    this.#rootSessionId = rootSessionId
    this.#rows = Object.freeze([])
    this.#signatures.clear()
    this.#selectedId = undefined
    this.#composingFollowupFor = undefined
    this.#followupText = ''
    this.#error = undefined
    this.#truncated = false
    this.#publish()
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#rows.length < 2) return false
    const current = this.#selectedIndex()
    const next = direction === 'down'
      ? (current + 1) % this.#rows.length
      : (current - 1 + this.#rows.length) % this.#rows.length
    this.#selectedId = this.#rows[next]?.id
    this.#publish()
    return true
  }

  selected(): SubagentRow | undefined {
    this.#assertActive()
    return this.#rows[this.#selectedIndex()]
  }

  acknowledge(): boolean {
    this.#assertActive()
    if (!this.#rows.some(row => row.unread)) return false
    this.#rows = Object.freeze(this.#rows.map(row => (
      row.unread ? Object.freeze({ ...row, unread: false }) : row
    )))
    this.#publish()
    return true
  }

  /**
   * Interrupt the selected live continuable child under this session's human
   * parent address. Fire-and-return: the target may keep running until it
   * observes the signal, so the row is not marked stopped here.
   */
  interrupt(): boolean {
    this.#assertActive()
    const service = this.#service
    const row = this.selected()
    if (
      service === undefined
      || row === undefined
      || row.kind !== 'child'
      || row.mode !== 'continuable'
      || row.activity !== 'running'
    ) {
      return false
    }
    try {
      service.interrupt(row.id, { kind: 'user', parentSessionId: this.#rootSessionId })
    } catch (error) {
      this.#recordError(error)
      return false
    }
    return true
  }

  /**
   * Deliver a human follow-up to a continuable child. Only a direct child can be
   * addressed: `followup` requires the exact live direct parent, and this
   * session is that only at depth 1. Deeper descendants fail closed rather than
   * borrowing an authority this session does not hold.
   */
  canFollowup(row: SubagentRow | undefined = this.selected()): boolean {
    return row !== undefined
      && row.kind === 'child'
      && row.mode === 'continuable'
      && row.depth === 1
      && row.parentId === this.#agent.id
  }

  /**
   * Arm a follow-up draft against the selected child. The draft is keyed to
   * that exact child so a selection change cannot silently redirect it.
   */
  beginFollowup(): boolean {
    this.#assertActive()
    const row = this.selected()
    if (row === undefined || !this.canFollowup(row)) return false
    this.#composingFollowupFor = row.id
    this.#followupText = ''
    this.#publish()
    return true
  }

  setFollowupText(text: string): boolean {
    this.#assertActive()
    if (this.#composingFollowupFor === undefined) return false
    this.#followupText = boundedText(text, MAX_FOLLOWUP_CODE_UNITS)
    this.#publish()
    return true
  }

  cancelFollowup(): boolean {
    this.#assertActive()
    if (this.#composingFollowupFor === undefined) return false
    this.#composingFollowupFor = undefined
    this.#followupText = ''
    this.#publish()
    return true
  }

  async followup(text: string = this.#followupText): Promise<'delivered' | 'failed' | 'refused'> {
    this.#assertActive()
    const service = this.#service
    // A draft addresses the child it was armed against, not whatever is selected now.
    const target = this.#composingFollowupFor
    const row = target === undefined
      ? this.selected()
      : this.#rows.find(candidate => candidate.id === target)
    if (service === undefined || row === undefined || !this.canFollowup(row)) {
      this.#composingFollowupFor = undefined
      this.#followupText = ''
      return 'refused'
    }
    const content = text.trim()
    if (content === '') return 'refused'
    // The draft is consumed before delivery is attempted, so a failure cannot
    // leave a stale draft that a later Enter would resend.
    this.#composingFollowupFor = undefined
    this.#followupText = ''
    this.#publish()
    const controller = new AbortController()
    try {
      await service.followup(
        this.#agent,
        row.id,
        [{ text: boundedText(content, MAX_FOLLOWUP_CODE_UNITS), type: 'text' }],
        { signal: controller.signal, source: { kind: 'user' } },
      )
    } catch (error) {
      if (this.#disposed) return 'failed'
      this.#recordError(error)
      return 'failed'
    }
    return 'delivered'
  }

  /**
   * Hand the selected child's durable session id to the runtime's attachment
   * owner. This controller never creates or resumes an Agent itself.
   */
  attach(): boolean {
    this.#assertActive()
    const attach = this.#attach
    const row = this.selected()
    if (attach === undefined || row === undefined || row.kind !== 'child') return false
    try {
      attach(row.id)
    } catch (error) {
      this.#recordError(error)
      return false
    }
    return true
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
    if (this.#disposed) throw new Error('SubagentTreeController is disposed')
  }

  #toRow(entry: SubagentDescendantListEntry): SubagentRow {
    const key = String(entry.id)
    const signature = signatureOf(entry)
    const unread = this.#signatures.get(key) !== signature
    this.#signatures.set(key, signature)
    const base = {
      depth: entry.depth,
      id: entry.id,
      parentId: entry.parentId,
      unread,
    }
    if (entry.kind === 'diagnostic') {
      return Object.freeze({ ...base, kind: 'diagnostic' as const, reason: entry.reason })
    }
    return Object.freeze({
      ...base,
      activity: entry.activity,
      hasChildren: entry.hasChildren,
      kind: 'child' as const,
      ...(entry.label === undefined ? {} : { label: boundedText(entry.label, MAX_LABEL_CODE_UNITS) }),
      mode: entry.mode,
    })
  }

  /** A child that left the tree must not keep its unread signature alive. */
  #pruneSignatures(): void {
    const live = new Set(this.#rows.map(row => String(row.id)))
    for (const key of [...this.#signatures.keys()]) {
      if (!live.has(key)) this.#signatures.delete(key)
    }
  }

  #selectedIndex(): number {
    const id = this.#selectedId
    if (id === undefined) return 0
    const index = this.#rows.findIndex(row => row.id === id)
    return index < 0 ? 0 : index
  }

  /** Selection follows a session id, so a disappearing agent cannot retarget it. */
  #reconcileSelection(): void {
    if (this.#rows.length === 0) {
      this.#selectedId = undefined
      return
    }
    const id = this.#selectedId
    if (id === undefined || !this.#rows.some(row => row.id === id)) {
      this.#selectedId = this.#rows[0]?.id
    }
  }

  /** A draft cannot outlive the child it addresses becoming unreachable. */
  #reconcileFollowup(): void {
    const target = this.#composingFollowupFor
    if (target === undefined) return
    const row = this.#rows.find(candidate => candidate.id === target)
    if (row === undefined || !this.canFollowup(row)) {
      this.#composingFollowupFor = undefined
      this.#followupText = ''
    }
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

  #createSnapshot(): SubagentTreeSnapshot {
    const status: SubagentTreeSnapshot['status'] = this.#service === undefined
      ? 'unavailable'
      : this.#error !== undefined
        ? 'error'
        : this.#composingFollowupFor !== undefined
          ? 'followup-input'
          : this.#busy ? 'loading' : 'ready'
    return Object.freeze({
      busy: this.#busy,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      followupText: this.#followupText,
      revision: this.#revision,
      rootSessionId: this.#rootSessionId,
      rows: this.#rows,
      ...(this.#rows.length === 0 ? {} : { selectedIndex: this.#selectedIndex() }),
      status,
      truncated: this.#truncated,
      unreadCount: this.#rows.filter(row => row.unread).length,
    })
  }
}
