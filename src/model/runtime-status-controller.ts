import type {} from '@deepseek-ai/dsh-user-approval/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

type Listener = () => void

export interface RuntimeStatusSnapshot {
  readonly approvalPolicy?: 'ask' | 'never'
  readonly contextWindow?: number
  readonly model?: string
  readonly permissionPreset?: string
  readonly revision: number
  readonly totalTokens?: number
}

function boundedSum(left: number, right: unknown): number {
  if (typeof right !== 'number' || !Number.isFinite(right) || right < 0) return left
  return Math.min(Number.MAX_SAFE_INTEGER, left + Math.floor(right))
}

function usageTotal(event: SessionEvent<'assistant/message'>): number {
  const usage = event.data.usage
  if (usage === undefined) return 0
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].reduce(boundedSum, 0)
}

export class RuntimeStatusController {
  readonly #listeners = new Set<Listener>()
  #approvalPolicy: RuntimeStatusSnapshot['approvalPolicy']
  #contextWindow: number | undefined
  #disposed = false
  #model: string | undefined
  #nextSeq = 0
  #permissionPreset: string | undefined
  #revision = 0
  #snapshot: RuntimeStatusSnapshot
  #totalTokens = 0

  constructor(model?: { readonly model?: string, readonly provider?: string }) {
    this.#model = this.#modelLabel(model)
    this.#snapshot = this.#createSnapshot()
  }

  getSnapshot = (): RuntimeStatusSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    if (this.#disposed) throw new Error('RuntimeStatusController is disposed')
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  setModel(model: { readonly model?: string, readonly provider?: string }): void {
    if (this.#disposed) throw new Error('RuntimeStatusController is disposed')
    const label = this.#modelLabel(model)
    if (label === this.#model) return
    this.#model = label
    this.#publish()
  }

  accept(events: readonly SessionEvent[], signal?: AbortSignal): void {
    if (this.#disposed) throw new Error('RuntimeStatusController is disposed')
    let changed = false
    for (const event of events) {
      if (signal?.aborted === true) return
      if (event.seq !== this.#nextSeq) {
        throw new Error(`Runtime status sequence gap: expected ${String(this.#nextSeq)}, got ${String(event.seq)}`)
      }
      this.#nextSeq += 1
      const extensible = event as unknown as {
        readonly data: { readonly preset?: unknown }
        readonly type: string
      }
      if (extensible.type === 'permission/preset') {
        if (typeof extensible.data.preset === 'string' && extensible.data.preset !== '') {
          this.#permissionPreset = extensible.data.preset.slice(0, 100)
          changed = true
        }
      } else if (event.type === 'approval/policy') {
        this.#approvalPolicy = event.data.policy
        changed = true
      } else if (event.type === 'request/context') {
        this.#model = `${event.data.provider}/${event.data.model}`
        this.#contextWindow = event.data.contextWindow
        changed = true
      } else if (event.type === 'assistant/message') {
        const addition = usageTotal(event)
        if (addition > 0) {
          this.#totalTokens = boundedSum(this.#totalTokens, addition)
          changed = true
        }
      }
    }
    if (changed) this.#publish()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
  }

  #createSnapshot(): RuntimeStatusSnapshot {
    return Object.freeze({
      ...(this.#approvalPolicy === undefined ? {} : { approvalPolicy: this.#approvalPolicy }),
      ...(this.#contextWindow === undefined ? {} : { contextWindow: this.#contextWindow }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#permissionPreset === undefined ? {} : { permissionPreset: this.#permissionPreset }),
      revision: this.#revision,
      ...(this.#totalTokens === 0 ? {} : { totalTokens: this.#totalTokens }),
    })
  }

  #modelLabel(model: { readonly model?: string, readonly provider?: string } | undefined): string | undefined {
    if (model?.provider === undefined || model.model === undefined) return undefined
    return `${model.provider}/${model.model}`
  }

  #publish(): void {
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of this.#listeners) listener()
  }
}
