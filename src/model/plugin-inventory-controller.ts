import type {
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from '@deepseek-ai/dsh-host-plugin-inventory'

const DEFAULT_MAX_ENTRIES = 500
const MAX_TEXT_CODE_UNITS = 300

type Listener = () => void

/**
 * Why the panel cannot enable or disable a plugin.
 *
 * The inventory is a read-only projection of the Loader's entry state. Toggling
 * an entry would mean writing the Loader tree or the profile document, and
 * neither is exposed as a public transaction on this baseline. Doing it by
 * reaching into Loader internals would leave the running fiber and the stored
 * configuration able to disagree, with no owner to reconcile them.
 */
export type PluginMutationState = 'read-only-no-public-transaction'

export interface PluginRow {
  readonly enabled: boolean
  readonly entryId: string
  /** `null` from the Loader means the entry has no live root fiber. */
  readonly fiberPhase: Exclude<PluginFiberPhase, null> | 'none'
  readonly moduleName: string
}

export interface PluginDiagnostic {
  readonly entryId: string
  readonly moduleName: string
  readonly summary: string
}

export interface PluginInventoryControllerSnapshot {
  readonly diagnostics: readonly PluginDiagnostic[]
  readonly droppedEntries: number
  readonly error?: string
  readonly failedCount: number
  readonly mutation: PluginMutationState
  readonly revision: number
  readonly rows: readonly PluginRow[]
  readonly selectedIndex?: number
  readonly status: 'error' | 'ready' | 'unavailable'
}

export interface PluginInventoryOptions {
  readonly maxEntries?: number
  readonly reportError?: (error: unknown) => void
}

/**
 * The inventory seam, narrowed to its read. The gateway reads the Loader
 * directly on every call and keeps no cache, so re-reading is what makes an
 * HMR swap or a disposal visible — this controller must not cache either.
 */
export interface PluginInventorySource {
  list(): PluginInventorySnapshot
}

const PHASES: readonly string[] = ['pending', 'loading', 'active', 'failed', 'unloading']

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
    return '<unrenderable plugin inventory failure>'
  }
}

/** An unknown phase from a newer Loader is preserved as a fact, not coerced. */
function phaseOf(entry: PluginInventoryEntry): PluginRow['fiberPhase'] {
  const phase = entry.fiberPhase
  if (phase === null || phase === undefined) return 'none'
  return PHASES.includes(phase)
    ? phase as Exclude<PluginFiberPhase, null>
    : boundedText(String(phase), 40) as Exclude<PluginFiberPhase, null>
}

export class PluginInventoryController {
  readonly #listeners = new Set<Listener>()
  readonly #maxEntries: number
  readonly #reportError: (error: unknown) => void
  readonly #source: PluginInventorySource | undefined
  #diagnostics: readonly PluginDiagnostic[] = Object.freeze([])
  #disposed = false
  #droppedEntries = 0
  #error: string | undefined
  #generation = 0
  #revision = 0
  #rows: readonly PluginRow[] = Object.freeze([])
  #selectedId: string | undefined
  #snapshot: PluginInventoryControllerSnapshot
  #stop: (() => void) | undefined

  constructor(
    source?: PluginInventorySource,
    /** Invalidation signal, wired to the Loader's HMR/disposal notifications. */
    onChange?: (listener: Listener) => () => void,
    options: PluginInventoryOptions = {},
  ) {
    this.#source = source
    this.#maxEntries = positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries')
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot()
    if (source === undefined) return
    if (onChange !== undefined) {
      try {
        this.#stop = onChange(() => {
          if (!this.#disposed) this.refresh()
        })
      } catch (error) {
        this.#reportError(error)
      }
    }
    this.refresh()
  }

  getSnapshot = (): PluginInventoryControllerSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Re-read the Loader projection. The rows are rebuilt, never patched. */
  refresh(): boolean {
    this.#assertActive()
    const source = this.#source
    if (source === undefined) return false
    const generation = ++this.#generation
    let snapshot: PluginInventorySnapshot
    try {
      snapshot = source.list()
    } catch (error) {
      this.#recordError(error)
      return false
    }
    if (generation !== this.#generation) return false
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.entries)) {
      this.#recordError(new Error('Plugin inventory returned an invalid snapshot'))
      return false
    }
    this.#ingest(snapshot.entries)
    this.#error = undefined
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
    this.#selectedId = this.#rows[next]?.entryId
    this.#publish()
    return true
  }

  selected(): PluginRow | undefined {
    this.#assertActive()
    return this.#rows[this.#selectedIndex()]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    const stop = this.#stop
    this.#stop = undefined
    try {
      stop?.()
    } catch (error) {
      this.#reportError(error)
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('PluginInventoryController is disposed')
  }

  #ingest(entries: readonly PluginInventoryEntry[]): void {
    this.#droppedEntries = Math.max(0, entries.length - this.#maxEntries)
    const rows = entries.slice(0, this.#maxEntries).map(entry => Object.freeze({
      enabled: entry.enabled === true,
      entryId: boundedText(String(entry.entryId), 200),
      fiberPhase: phaseOf(entry),
      moduleName: boundedText(String(entry.moduleName)),
    }))
    this.#rows = Object.freeze(rows)
    // A failed fiber is the diagnostic; the Loader publishes no failure text on
    // this baseline, so the phase is reported without inventing a cause.
    this.#diagnostics = Object.freeze(
      rows.filter(row => row.fiberPhase === 'failed').map(row => Object.freeze({
        entryId: row.entryId,
        moduleName: row.moduleName,
        summary: row.enabled
          ? 'Enabled entry whose root fiber failed to load'
          : 'Disabled entry left in a failed fiber state',
      })),
    )
    this.#reconcileSelection()
  }

  /** Selection follows an entry id, so an HMR swap cannot retarget it. */
  #reconcileSelection(): void {
    if (this.#rows.length === 0) {
      this.#selectedId = undefined
      return
    }
    const id = this.#selectedId
    if (id === undefined || !this.#rows.some(row => row.entryId === id)) {
      this.#selectedId = this.#rows[0]?.entryId
    }
  }

  #selectedIndex(): number {
    const id = this.#selectedId
    if (id === undefined) return 0
    const index = this.#rows.findIndex(row => row.entryId === id)
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

  #createSnapshot(): PluginInventoryControllerSnapshot {
    const status: PluginInventoryControllerSnapshot['status'] = this.#source === undefined
      ? 'unavailable'
      : this.#error !== undefined ? 'error' : 'ready'
    return Object.freeze({
      diagnostics: this.#diagnostics,
      droppedEntries: this.#droppedEntries,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      failedCount: this.#rows.filter(row => row.fiberPhase === 'failed').length,
      mutation: 'read-only-no-public-transaction',
      revision: this.#revision,
      rows: this.#rows,
      ...(this.#rows.length === 0 ? {} : { selectedIndex: this.#selectedIndex() }),
      status,
    })
  }
}
