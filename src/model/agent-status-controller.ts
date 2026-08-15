import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'

export interface AgentStatusStore {
  readonly getSnapshot: () => AgentStatus
  readonly subscribe: (listener: () => void) => () => void
}

export class AgentStatusController implements AgentStatusStore {
  readonly #agent: Agent
  readonly #listeners = new Set<() => void>()
  readonly #reportError: (error: unknown) => void
  #disposed = false
  #status: AgentStatus
  #stop: (() => void) | undefined

  constructor(agent: Agent, reportError: (error: unknown) => void = () => undefined) {
    this.#agent = agent
    this.#status = agent.status
    this.#reportError = reportError
    this.#stop = agent.ctx.on('agent/status', ({ agent: changed, status }) => {
      if (this.#disposed || changed !== this.#agent || status === this.#status) return
      this.#status = status
      this.#notify()
    })
  }

  readonly getSnapshot = (): AgentStatus => this.#status

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) throw new Error('Agent status controller is disposed')
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const stop = this.#stop
    this.#stop = undefined
    stop?.()
    this.#listeners.clear()
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        try {
          this.#reportError(error)
        } catch {
          // A status observer and diagnostic sink cannot own agent progress.
        }
      }
    }
  }
}
