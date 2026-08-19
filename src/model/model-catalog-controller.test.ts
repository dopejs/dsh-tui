import { describe, expect, it } from 'vitest'

import { ModelCatalogController } from './model-catalog-controller'

function source(overrides: {
  listModels?: (provider: string) => Promise<readonly { readonly id: string }[]>
  providers?: readonly { readonly id: string, readonly name: string }[]
} = {}) {
  return {
    listModels: overrides.listModels ?? (async () => [{ id: 'a' }, { id: 'b' }]),
    listProviders: () => overrides.providers ?? [{ id: 'ark', name: 'Ark' }],
  }
}

describe('ModelCatalogController (M7.4)', () => {
  it('lists every provider route in the form /model accepts', async () => {
    const catalog = new ModelCatalogController(source({
      providers: [{ id: 'ark', name: 'Ark' }, { id: 'local', name: 'Local' }],
    }))
    await catalog.load()

    expect(catalog.getSnapshot().routes.map(route => route.id))
      .toEqual(['ark/a', 'ark/b', 'local/a', 'local/b'])
    catalog.dispose()
  })

  // A provider that is slow or unreachable must not decide whether the others
  // are shown; and a model missing from a list is indistinguishable from a
  // model that does not exist, so the failure is reported rather than dropped.
  it('keeps the providers that answered and names the one that did not', async () => {
    const catalog = new ModelCatalogController(source({
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('no credential')
        return [{ id: 'a' }]
      },
      providers: [{ id: 'ark', name: 'Ark' }, { id: 'broken', name: 'Broken' }],
    }))
    await catalog.load()

    const snapshot = catalog.getSnapshot()
    expect(snapshot.routes.map(route => route.id)).toEqual(['ark/a'])
    expect(snapshot.failures).toEqual([{ provider: 'broken', reason: 'no credential' }])
    catalog.dispose()
  })

  it('reports that it is loading, and stops when it is not', async () => {
    const catalog = new ModelCatalogController(source())
    const seen: boolean[] = []
    catalog.subscribe(() => seen.push(catalog.getSnapshot().loading))

    await catalog.load()

    expect(seen).toEqual([true, false])
    expect(catalog.getSnapshot().loading).toBe(false)
    catalog.dispose()
  })

  // A reload started while another is in flight must win, whichever finishes
  // first: the newer answer is the one the user asked for.
  it('does not let a stale load publish over a newer one', async () => {
    let release: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    const catalog = new ModelCatalogController(source({
      listModels: async () => {
        call += 1
        if (call === 1) {
          await slow
          return [{ id: 'stale' }]
        }
        return [{ id: 'fresh' }]
      },
    }))

    const first = catalog.load()
    const second = catalog.load()
    await second
    release?.()
    await first

    expect(catalog.getSnapshot().routes.map(route => route.model)).toEqual(['fresh'])
    catalog.dispose()
  })

  it('publishes nothing once disposed', async () => {
    const catalog = new ModelCatalogController(source())
    let notified = 0
    catalog.subscribe(() => {
      notified += 1
    })
    catalog.dispose()
    await catalog.load()

    expect(notified).toBe(0)
    expect(catalog.getSnapshot().routes).toEqual([])
  })
})
