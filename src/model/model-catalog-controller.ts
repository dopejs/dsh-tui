/**
 * The models a session can be started on.
 *
 * `/model provider/model` needed the exact route typed from memory, and typing
 * it wrong was answered with usage text. A list the host already knows how to
 * produce is a better answer than a correction.
 *
 * Catalog membership is advisory upstream -- it never controls routing -- so
 * nothing here is treated as authoritative beyond "this is what the provider
 * advertised". A provider that fails to answer is reported as having failed,
 * not quietly dropped: a model missing from the list is indistinguishable from
 * a model that does not exist, and the two call for different reactions.
 */

export interface ModelRoute {
  /** `provider/model`, exactly as `/model` accepts it. */
  readonly id: string
  readonly model: string
  readonly provider: string
  /** Provider's human-readable name, when it differs from its route key. */
  readonly providerName: string
}

export interface ModelCatalogSnapshot {
  /** Index into `routes`, so a list can be walked without a second source. */
  readonly cursor: number
  /** Set when `/model` was called with nothing to act on. */
  readonly picking: boolean
  readonly loading: boolean
  /** Providers that could not be listed, with why. */
  readonly failures: readonly { readonly provider: string, readonly reason: string }[]
  readonly routes: readonly ModelRoute[]
}

export interface ModelCatalogSource {
  readonly listModels: (provider: string) => Promise<readonly { readonly id: string }[]>
  readonly listProviders: () => readonly { readonly id: string, readonly name: string }[]
}

/** The snapshot a session without a catalog reports: nothing, not loading. */
export const EMPTY_MODEL_CATALOG: ModelCatalogSnapshot = Object.freeze({
  cursor: 0,
  failures: Object.freeze([]),
  loading: false,
  picking: false,
  routes: Object.freeze([]),
})

const EMPTY = EMPTY_MODEL_CATALOG

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ModelCatalogController {
  readonly #listeners = new Set<() => void>()
  readonly #source: ModelCatalogSource
  #disposed = false
  #snapshot: ModelCatalogSnapshot = EMPTY
  /** Guards against a stale load publishing over a newer one. */
  #generation = 0

  constructor(source: ModelCatalogSource) {
    this.#source = source
  }

  readonly getSnapshot = (): ModelCatalogSnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Ask every provider what it advertises.
   *
   * Providers are asked concurrently and independently: one that is slow or
   * unreachable must not decide whether the others are shown.
   */
  async load(): Promise<void> {
    if (this.#disposed) return
    const generation = this.#generation + 1
    this.#generation = generation
    this.#publish({ ...this.#snapshot, loading: true })

    const providers = this.#source.listProviders()
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await this.#source.listModels(provider.id)
        return {
          routes: models.map(model => Object.freeze({
            id: `${provider.id}/${model.id}`,
            model: model.id,
            provider: provider.id,
            providerName: provider.name,
          })),
        }
      } catch (error) {
        return { failure: { provider: provider.id, reason: reasonOf(error) } }
      }
    }))

    if (this.#disposed || generation !== this.#generation) return
    this.#publish(Object.freeze({
      cursor: 0,
      failures: Object.freeze(results.flatMap(result => result.failure ?? [])),
      loading: false,
      picking: this.#snapshot.picking,
      routes: Object.freeze(results.flatMap(result => result.routes ?? [])),
    }))
  }

  /**
   * Ask for the list to be shown.
   *
   * `/model` runs in the command layer, which has no way to open a panel, so
   * it raises a flag the view is watching. Printing the routes instead made
   * the user copy one back out of the transcript by hand.
   */
  requestPicker(): void {
    if (this.#disposed) return
    this.#publish({ ...this.#snapshot, cursor: 0, picking: true })
  }

  closePicker(): void {
    if (this.#disposed || !this.#snapshot.picking) return
    this.#publish({ ...this.#snapshot, picking: false })
  }

  /** Move the selection, stopping at either end rather than wrapping. */
  move(direction: 'down' | 'up'): boolean {
    if (this.#disposed || this.#snapshot.routes.length === 0) return false
    const next = Math.max(0, Math.min(
      this.#snapshot.routes.length - 1,
      this.#snapshot.cursor + (direction === 'down' ? 1 : -1),
    ))
    if (next === this.#snapshot.cursor) return false
    this.#publish({ ...this.#snapshot, cursor: next })
    return true
  }

  selected(): ModelRoute | undefined {
    return this.#snapshot.routes[this.#snapshot.cursor]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    this.#listeners.clear()
  }

  #publish(snapshot: ModelCatalogSnapshot): void {
    this.#snapshot = Object.freeze(snapshot)
    for (const listener of this.#listeners) listener()
  }
}
