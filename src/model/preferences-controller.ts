export type PreferenceAction = 'command.palette' | 'session.center' | 'transcript.search'

export interface TuiPreferences {
  readonly keymap: Readonly<Record<PreferenceAction, string>>
  readonly theme: 'default' | 'no-color'
}

export interface PreferencesSnapshot extends TuiPreferences {
  readonly revision: number
  readonly warning?: string
}

const DEFAULT_KEYMAP: Readonly<Record<PreferenceAction, string>> = Object.freeze({
  'command.palette': 'ctrl+p',
  'session.center': 'ctrl+o',
  'transcript.search': 'ctrl+f',
})

const ACTIONS = Object.freeze(Object.keys(DEFAULT_KEYMAP) as PreferenceAction[])

function resolvePreferences(input: unknown): TuiPreferences {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('preferences must be an object')
  }
  const candidate = input as { readonly keymap?: unknown, readonly theme?: unknown }
  const theme = candidate.theme ?? 'default'
  if (theme !== 'default' && theme !== 'no-color') throw new Error('unsupported theme')
  const keymap = { ...DEFAULT_KEYMAP }
  if (candidate.keymap !== undefined) {
    if (typeof candidate.keymap !== 'object' || candidate.keymap === null || Array.isArray(candidate.keymap)) {
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
  return Object.freeze({ keymap: Object.freeze(keymap), theme })
}

export class PreferencesController {
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

  actionForChord(chord: string): PreferenceAction | undefined {
    return ACTIONS.find(action => this.#preferences.keymap[action] === chord)
  }

  replace(input: unknown): { readonly error?: string, readonly kind: 'applied' | 'rejected' } {
    try {
      const next = resolvePreferences(input)
      this.#preferences = next
      this.#revision += 1
      this.#snapshot = this.#createSnapshot()
      return { kind: 'applied' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), kind: 'rejected' }
    }
  }

  #createSnapshot(warning?: string): PreferencesSnapshot {
    return Object.freeze({
      keymap: this.#preferences.keymap,
      revision: this.#revision,
      theme: this.#preferences.theme,
      ...(warning === undefined ? {} : { warning }),
    })
  }
}
