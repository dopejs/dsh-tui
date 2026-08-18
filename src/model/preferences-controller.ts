export type PreferenceAction =
  | 'activity.center'
  | 'command.palette'
  | 'jobs.center'
  | 'projection.center'
  | 'session.center'
  | 'subagent.center'
  | 'transcript.search'

export type TuiTheme = 'default' | 'high-contrast' | 'no-color'

/**
 * How the TUI occupies the terminal.
 *
 * `alternate` takes the alternate screen and restores the scrollback on exit;
 * `inline` draws in the normal buffer, so the session stays in scrollback
 * afterwards. Neither is universally right: alternate keeps the shell clean,
 * inline keeps the transcript greppable in the terminal's own history.
 */
export type TuiRenderMode = 'alternate' | 'inline'

/**
 * Where the current preferences are being kept. `settings` means writes reach
 * the user's document; `process-only` means the settings service is absent or
 * read-only and edits last until exit. The distinction is surfaced rather than
 * hidden, because silently discarding a preference write at exit is worse than
 * refusing to promise persistence.
 */
export type PreferencePersistence = 'process-only' | 'settings'

export interface TuiPreferences {
  readonly keymap: Readonly<Record<PreferenceAction, string>>
  /** Suppress non-essential motion and transient redraws. */
  readonly reducedMotion: boolean
  readonly renderMode: TuiRenderMode
  /**
   * Drop box drawing and decorative glyphs. A screen reader announces border
   * characters as content, so a bordered panel is read out as noise around the
   * text the user actually asked for.
   */
  readonly screenReader: boolean
  readonly theme: TuiTheme
}

export interface PreferencesSnapshot extends TuiPreferences {
  readonly persistence: PreferencePersistence
  readonly revision: number
  readonly warning?: string
}

type Listener = () => void

const DEFAULT_KEYMAP: Readonly<Record<PreferenceAction, string>> = Object.freeze({
  'activity.center': 'ctrl+y',
  'command.palette': 'ctrl+p',
  'jobs.center': 'ctrl+b',
  'projection.center': 'ctrl+u',
  'session.center': 'ctrl+o',
  'subagent.center': 'ctrl+g',
  'transcript.search': 'ctrl+f',
})

const ACTIONS = Object.freeze(Object.keys(DEFAULT_KEYMAP) as PreferenceAction[])
const THEMES = Object.freeze(['default', 'high-contrast', 'no-color'] as const)
const RENDER_MODES = Object.freeze(['alternate', 'inline'] as const)

export const DEFAULT_PREFERENCES: TuiPreferences = Object.freeze({
  keymap: DEFAULT_KEYMAP,
  reducedMotion: false,
  renderMode: 'alternate',
  screenReader: false,
  theme: 'default',
})

/**
 * Validate a candidate document into complete preferences. Validation is
 * all-or-nothing: a document with one bad chord is rejected whole rather than
 * partially applied, so the running keymap is never a mixture of the user's
 * intent and the defaults.
 */
export function resolvePreferences(input: unknown): TuiPreferences {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('preferences must be an object')
  }
  const candidate = input as {
    readonly keymap?: unknown
    readonly reducedMotion?: unknown
    readonly renderMode?: unknown
    readonly screenReader?: unknown
    readonly theme?: unknown
  }
  const theme = candidate.theme ?? 'default'
  if (!THEMES.includes(theme as TuiTheme)) throw new Error('unsupported theme')
  const reducedMotion = candidate.reducedMotion ?? false
  if (typeof reducedMotion !== 'boolean') throw new Error('reducedMotion must be a boolean')
  const screenReader = candidate.screenReader ?? false
  if (typeof screenReader !== 'boolean') throw new Error('screenReader must be a boolean')
  const renderMode = candidate.renderMode ?? 'alternate'
  if (!RENDER_MODES.includes(renderMode as TuiRenderMode)) {
    throw new Error('unsupported renderMode')
  }
  const keymap = { ...DEFAULT_KEYMAP }
  if (candidate.keymap !== undefined) {
    if (
      typeof candidate.keymap !== 'object'
      || candidate.keymap === null
      || Array.isArray(candidate.keymap)
    ) {
      throw new Error('keymap must be an object')
    }
    const overrides = candidate.keymap as Record<string, unknown>
    for (const key of Object.keys(overrides)) {
      if (!ACTIONS.includes(key as PreferenceAction)) throw new Error(`unknown keymap action: ${key}`)
      const chord = overrides[key]
      if (typeof chord !== 'string' || !/^(ctrl|alt)(\+shift)?\+[a-z]$/.test(chord)) {
        throw new Error(`invalid key chord for ${key}`)
      }
      keymap[key as PreferenceAction] = chord
    }
  }
  const seen = new Set<string>()
  for (const chord of Object.values(keymap)) {
    if (seen.has(chord)) throw new Error(`keymap collision: ${chord}`)
    seen.add(chord)
  }
  return Object.freeze({
    keymap: Object.freeze(keymap),
    reducedMotion,
    renderMode: renderMode as TuiRenderMode,
    screenReader,
    theme: theme as TuiTheme,
  })
}

export class PreferencesController {
  readonly #listeners = new Set<Listener>()
  #persistence: PreferencePersistence = 'process-only'
  #preferences: TuiPreferences
  #revision = 0
  #snapshot: PreferencesSnapshot

  constructor(input?: unknown) {
    try {
      this.#preferences = input === undefined
        ? resolvePreferences({})
        : resolvePreferences(input)
      this.#snapshot = this.#createSnapshot()
    } catch (error) {
      this.#preferences = resolvePreferences({})
      this.#snapshot = this.#createSnapshot(error instanceof Error ? error.message : String(error))
    }
  }

  getSnapshot = (): PreferencesSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  actionForChord(chord: string): PreferenceAction | undefined {
    return ACTIONS.find(action => this.#preferences.keymap[action] === chord)
  }

  /** Record where preferences are actually kept, so the UI can say so. */
  setPersistence(persistence: PreferencePersistence): void {
    if (this.#persistence === persistence) return
    this.#persistence = persistence
    this.#publish(this.#createSnapshot())
  }

  replace(input: unknown): { readonly error?: string, readonly kind: 'applied' | 'rejected' } {
    try {
      const next = resolvePreferences(input)
      this.#preferences = next
      this.#revision += 1
      this.#publish(this.#createSnapshot())
      return { kind: 'applied' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), kind: 'rejected' }
    }
  }

  /**
   * Apply a document that failed to persist, keeping the value the user can see
   * consistent with the warning that explains why it will not survive exit.
   */
  applyWithWarning(input: unknown, warning: string): void {
    try {
      this.#preferences = resolvePreferences(input)
    } catch {
      this.#preferences = resolvePreferences({})
    }
    this.#revision += 1
    this.#publish(this.#createSnapshot(warning))
  }

  #publish(snapshot: PreferencesSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of [...this.#listeners]) listener()
  }

  #createSnapshot(warning?: string): PreferencesSnapshot {
    return Object.freeze({
      keymap: this.#preferences.keymap,
      persistence: this.#persistence,
      reducedMotion: this.#preferences.reducedMotion,
      renderMode: this.#preferences.renderMode,
      revision: this.#revision,
      screenReader: this.#preferences.screenReader,
      theme: this.#preferences.theme,
      ...(warning === undefined ? {} : { warning }),
    })
  }
}
