import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'

const MAX_PRESETS = 100
const MAX_CONFIRMATION_CODE_UNITS = 200

type Listener = () => void

export interface PermissionPresetItem {
  readonly approval: string
  readonly dangerous: boolean
  readonly description?: string
  readonly name: string
  readonly sandbox: string
  readonly selected: boolean
  readonly value: string
}

export interface PermissionSnapshot {
  readonly confirmationPhrase?: string
  readonly confirmationTarget?: string
  readonly confirmationText: string
  readonly error?: string
  readonly items: readonly PermissionPresetItem[]
  readonly revision: number
  readonly selectedIndex?: number
  readonly status: 'confirming' | 'error' | 'ready' | 'unavailable'
  readonly truncated: boolean
}

function errorMessage(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error)
    return value.length <= 500 ? value : `${value.slice(0, 499)}…`
  } catch {
    return '<unrenderable permission failure>'
  }
}

export class PermissionController {
  readonly #agent: Agent
  readonly #listeners = new Set<Listener>()
  readonly #service: PermissionPresetService | undefined
  #applying = false
  #confirmationTarget: string | undefined
  #confirmationText = ''
  #disposed = false
  #error: string | undefined
  #items: readonly PermissionPresetItem[] = Object.freeze([])
  #revision = 0
  #selectedIndex = 0
  #snapshot: PermissionSnapshot
  #status: PermissionSnapshot['status']
  #stop: (() => void) | undefined
  #truncated = false

  constructor(agent: Agent, service?: PermissionPresetService) {
    this.#agent = agent
    this.#service = service
    this.#status = service === undefined ? 'unavailable' : 'ready'
    this.#snapshot = this.#createSnapshot()
    if (service !== undefined) {
      this.#reload()
      this.#snapshot = this.#createSnapshot()
      this.#stop = agent.ctx.on('session/event', (session) => {
        if (this.#disposed || session !== this.#agent.session || this.#applying) return
        this.#reload()
        this.#publish()
      })
    }
  }

  getSnapshot = (): PermissionSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  selected(): PermissionPresetItem | undefined {
    return this.#snapshot.items[this.#selectedIndex]
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#status === 'confirming' || this.#items.length < 2) return false
    this.#selectedIndex = direction === 'down'
      ? (this.#selectedIndex + 1) % this.#items.length
      : (this.#selectedIndex - 1 + this.#items.length) % this.#items.length
    this.#publish()
    return true
  }

  requestSelected(): 'applied' | 'confirmation-required' | 'unchanged' | 'unavailable' {
    this.#assertActive()
    const selected = this.selected()
    if (this.#service === undefined || selected === undefined) return 'unavailable'
    if (selected.selected) return 'unchanged'
    if (selected.dangerous) {
      this.#confirmationTarget = selected.value
      this.#confirmationText = ''
      this.#status = 'confirming'
      this.#error = undefined
      this.#publish()
      return 'confirmation-required'
    }
    return this.#apply(selected.value) ? 'applied' : 'unchanged'
  }

  insertConfirmation(value: string): 'applied' | 'limit-exceeded' {
    this.#assertActive()
    if (this.#status !== 'confirming') return 'limit-exceeded'
    if (this.#confirmationText.length + value.length > MAX_CONFIRMATION_CODE_UNITS) {
      return 'limit-exceeded'
    }
    this.#confirmationText += value.replaceAll('\n', ' ')
    this.#publish()
    return 'applied'
  }

  backspaceConfirmation(): boolean {
    this.#assertActive()
    if (this.#status !== 'confirming' || this.#confirmationText === '') return false
    const characters = Array.from(this.#confirmationText)
    characters.pop()
    this.#confirmationText = characters.join('')
    this.#publish()
    return true
  }

  confirm(): boolean {
    this.#assertActive()
    const target = this.#confirmationTarget
    if (target === undefined || this.#confirmationText !== `enable ${target}`) {
      this.#error = `Type "${this.#confirmationPhrase(target)}" exactly to continue.`
      this.#publish()
      return false
    }
    this.#confirmationTarget = undefined
    this.#confirmationText = ''
    return this.#apply(target)
  }

  cancelConfirmation(): boolean {
    this.#assertActive()
    if (this.#status !== 'confirming') return false
    this.#confirmationTarget = undefined
    this.#confirmationText = ''
    this.#error = undefined
    this.#status = this.#service === undefined ? 'unavailable' : 'ready'
    this.#publish()
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#stop?.()
    this.#stop = undefined
    this.#listeners.clear()
  }

  #apply(value: string): boolean {
    const service = this.#service
    if (service === undefined) return false
    this.#applying = true
    this.#error = undefined
    try {
      service.set(this.#agent.session, value)
      this.#status = 'ready'
      this.#reload()
      this.#publish()
      return this.#status === 'ready'
    } catch (error) {
      this.#status = 'error'
      this.#error = errorMessage(error)
      this.#reload(false)
      this.#publish()
      return false
    } finally {
      this.#applying = false
    }
  }

  #reload(clearError = true): void {
    const service = this.#service
    if (service === undefined) return
    try {
      const current = service.current(this.#agent.session.events)
      const names = service.names.slice(0, MAX_PRESETS)
      this.#truncated = service.names.length > MAX_PRESETS
      this.#items = Object.freeze(names.map((value) => {
        const option = service.optionOf(value)
        const spec = service.resolve(value)
        return Object.freeze({
          approval: spec.approval,
          dangerous: spec.sandbox === 'danger-full-access',
          ...(option.description === undefined
            ? {}
            : { description: option.description.slice(0, 1_000) }),
          name: option.name.slice(0, 500),
          sandbox: spec.sandbox,
          selected: value === current,
          value,
        })
      }))
      const currentIndex = this.#items.findIndex(item => item.selected)
      this.#selectedIndex = currentIndex >= 0
        ? currentIndex
        : Math.min(this.#selectedIndex, Math.max(0, this.#items.length - 1))
      if (clearError && this.#status !== 'confirming') this.#status = 'ready'
      if (clearError) this.#error = undefined
    } catch (error) {
      this.#items = Object.freeze([])
      this.#status = 'error'
      this.#error = errorMessage(error)
    }
  }

  #confirmationPhrase(target = this.#confirmationTarget): string {
    return target === undefined ? '' : `enable ${target}`
  }

  #createSnapshot(): PermissionSnapshot {
    return Object.freeze({
      ...(this.#confirmationTarget === undefined
        ? {}
        : {
            confirmationPhrase: this.#confirmationPhrase(),
            confirmationTarget: this.#confirmationTarget,
          }),
      confirmationText: this.#confirmationText,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      items: this.#items,
      revision: this.#revision,
      ...(this.#items.length === 0 ? {} : { selectedIndex: this.#selectedIndex }),
      status: this.#status,
      truncated: this.#truncated,
    })
  }

  #publish(): void {
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of this.#listeners) listener()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('PermissionController is disposed')
  }
}
