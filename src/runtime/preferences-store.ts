import type {
  PreferencesController,
  TuiPreferences,
} from '../model/preferences-controller'
import { DEFAULT_PREFERENCES, resolvePreferences } from '../model/preferences-controller'

export const TUI_SETTINGS_NAMESPACE = 'dsh-tui'

/**
 * The settings seam this store needs, narrowed to one namespace scope. Keeping
 * the dependency at this shape lets the runtime pass a real `SettingsScope` and
 * the tests pass a fake without either importing the provider.
 */
export interface PreferencesScope {
  get(): unknown
  update(patch: object): Promise<void>
  watch(callback: (next: unknown, previous: unknown) => void): () => void
}

export interface PreferencesStoreOptions {
  readonly controller: PreferencesController
  readonly reportError?: (error: unknown) => void
  /** Absent service, or a provider whose `writable` is false, means process-only. */
  readonly scope?: PreferencesScope
  readonly writable?: boolean
}

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.length <= 300 ? value : `${value.slice(0, 299)}…`
}

/**
 * Bridges the TUI preference document to `ctx.settings`.
 *
 * Persistence is a capability, not an assumption: without a writable scope the
 * store stays process-only and says so, instead of accepting edits it will drop
 * at exit. An externally edited document that fails validation keeps the last
 * good value and warns, matching how the settings service itself treats a
 * section its owner cannot act on.
 */
export class PreferencesStore {
  readonly #controller: PreferencesController
  readonly #reportError: (error: unknown) => void
  readonly #scope: PreferencesScope | undefined
  readonly #writable: boolean
  #applied: TuiPreferences = DEFAULT_PREFERENCES
  #disposed = false
  #stop: (() => void) | undefined

  constructor(options: PreferencesStoreOptions) {
    this.#controller = options.controller
    this.#reportError = options.reportError ?? (() => undefined)
    this.#scope = options.scope
    this.#writable = options.scope !== undefined && options.writable === true
    this.#controller.setPersistence(this.#writable ? 'settings' : 'process-only')
    const scope = options.scope
    if (scope === undefined) return
    this.#adopt(this.#read(scope), 'the stored preference document')
    try {
      this.#stop = scope.watch((next) => {
        if (this.#disposed) return
        this.#adopt(next, 'the externally edited preference document')
      })
    } catch (error) {
      this.#reportError(error)
    }
  }

  /** The preferences currently in force, whatever their source. */
  current(): TuiPreferences {
    return this.#applied
  }

  /**
   * Validate and apply a complete document, then persist it when possible. A
   * rejected document changes nothing; an unpersistable but valid one is
   * applied with an explicit warning rather than silently lost.
   */
  async save(input: unknown): Promise<'applied' | 'process-only' | 'rejected'> {
    if (this.#disposed) return 'rejected'
    let next: TuiPreferences
    try {
      next = resolvePreferences(input)
    } catch (error) {
      this.#reportError(error)
      return 'rejected'
    }
    const scope = this.#scope
    if (!this.#writable || scope === undefined) {
      this.#applied = next
      this.#controller.applyWithWarning(
        next,
        'Preferences are not persisted: the settings service is unavailable or read-only.',
      )
      return 'process-only'
    }
    try {
      await scope.update({
        keymap: { ...next.keymap },
        reducedMotion: next.reducedMotion,
        renderMode: next.renderMode,
        screenReader: next.screenReader,
        theme: next.theme,
      })
    } catch (error) {
      this.#reportError(error)
      this.#applied = next
      this.#controller.applyWithWarning(
        next,
        `Preferences were applied but not saved: ${message(error)}`,
      )
      return 'process-only'
    }
    // The watch callback normally publishes the committed value; applying it
    // here too keeps the caller's own read consistent before that lands.
    this.#applied = next
    this.#controller.replace(next)
    return 'applied'
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const stop = this.#stop
    this.#stop = undefined
    try {
      stop?.()
    } catch (error) {
      this.#reportError(error)
    }
  }

  #read(scope: PreferencesScope): unknown {
    try {
      return scope.get()
    } catch (error) {
      this.#reportError(error)
      return undefined
    }
  }

  /** Adopt a document, keeping the last good value when it does not validate. */
  #adopt(value: unknown, description: string): void {
    if (value === undefined) return
    const result = this.#controller.replace(value)
    if (result.kind === 'applied') {
      try {
        this.#applied = resolvePreferences(value)
      } catch {
        // `replace` already accepted it, so this cannot disagree in practice;
        // keeping the previous value is the safe reading if it ever does.
      }
      return
    }
    const error = new Error(`Ignoring ${description}: ${result.error ?? 'invalid'}`)
    this.#reportError(error)
    this.#controller.applyWithWarning(this.#applied, error.message)
  }
}
