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
  readonly loading: boolean
  /** Providers that could not be listed, with why. */
  readonly failures: readonly { readonly provider: string, readonly reason: string }[]
  readonly routes: readonly ModelRoute[]
}

export interface ModelCatalogSource {
  readonly listModels: (provider: string) => Promise<readonly { readonly id: string }[]>
  readonly listProviders: () => readonly { readonly id: string, readonly name: string }[]
}

const EMPTY: ModelCatalogSnapshot = Object.freeze({
  failures: Object.freeze([]),
  loading: false,
  routes: Object.freeze([]),
})

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
      failures: Object.freeze(results.flatMap(result => result.failure ?? [])),
      loading: false,
      routes: Object.freeze(results.flatMap(result => result.routes ?? [])),
    }))
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
