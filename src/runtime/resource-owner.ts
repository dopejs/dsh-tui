export type Disposer = () => Promise<void> | void

interface OwnedResource {
  readonly dispose: Disposer
  readonly label: string
}

export class ResourceOwner {
  readonly #resources: OwnedResource[] = []
  #disposePromise: Promise<void> | undefined
  #open = true

  own(label: string, dispose: Disposer): void {
    if (!this.#open) {
      throw new Error(`Cannot acquire ${label}: resource owner is closing`)
    }
    this.#resources.push({ dispose, label })
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeAll()
    return this.#disposePromise
  }

  async #disposeAll(): Promise<void> {
    this.#open = false
    const failures: Error[] = []

    for (const resource of this.#resources.reverse()) {
      try {
        await resource.dispose()
      } catch (error) {
        failures.push(
          new Error(`Failed to dispose ${resource.label}`, {
            cause: error,
          }),
        )
      }
    }
    this.#resources.length = 0

    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more owned resources failed to dispose')
    }
  }
}
