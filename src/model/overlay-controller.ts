export type OverlayKind = 'activity' | 'changes' | 'command-palette' | 'completion' | 'jobs' | 'permissions' | 'projections' | 'recovery' | 'session-center' | 'subagents'
export type InputSurface = 'composer' | 'interaction' | 'overlay' | 'transcript-search'

type Listener = () => void

export interface OverlaySnapshot {
  readonly active?: OverlayKind
  readonly revision: number
}

export interface InputFocusState {
  readonly interactionActive: boolean
  readonly searchOpen: boolean
}

export function resolveInputSurface(
  overlay: OverlaySnapshot,
  state: InputFocusState,
): InputSurface {
  if (state.interactionActive) return 'interaction'
  if (overlay.active !== undefined) return 'overlay'
  if (state.searchOpen) return 'transcript-search'
  return 'composer'
}

export class OverlayController {
  readonly #listeners = new Set<Listener>()
  #active: OverlayKind | undefined
  #disposed = false
  #revision = 0
  #snapshot: OverlaySnapshot = Object.freeze({ revision: 0 })

  getSnapshot = (): OverlaySnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  open(kind: OverlayKind): boolean {
    this.#assertActive()
    if (this.#active === kind) return false
    this.#active = kind
    this.#publish()
    return true
  }

  close(kind?: OverlayKind): boolean {
    this.#assertActive()
    if (this.#active === undefined || (kind !== undefined && this.#active !== kind)) {
      return false
    }
    this.#active = undefined
    this.#publish()
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#active = undefined
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('OverlayController is disposed')
  }

  #publish(): void {
    this.#revision += 1
    this.#snapshot = Object.freeze({
      ...(this.#active === undefined ? {} : { active: this.#active }),
      revision: this.#revision,
    })
    for (const listener of this.#listeners) listener()
  }
}
