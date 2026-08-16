import { describe, expect, it, vi } from 'vitest'

import { PreferencesController } from '../model/preferences-controller'
import { PreferencesStore, type PreferencesScope } from './preferences-store'

class FakeScope implements PreferencesScope {
  readonly update = vi.fn<(patch: object) => Promise<void>>(async () => undefined)
  section: unknown
  watcher: ((next: unknown, previous: unknown) => void) | undefined
  unsubscribes = 0

  constructor(section: unknown = undefined) {
    this.section = section
  }

  get(): unknown {
    return this.section
  }

  watch(callback: (next: unknown, previous: unknown) => void): () => void {
    this.watcher = callback
    return () => {
      this.unsubscribes += 1
      this.watcher = undefined
    }
  }
}

function harness(scope?: PreferencesScope, writable = true) {
  const controller = new PreferencesController()
  const reportError = vi.fn()
  const store = new PreferencesStore({
    controller,
    reportError,
    ...(scope === undefined ? {} : { scope }),
    writable,
  })
  return { controller, reportError, store }
}

describe('PreferencesStore (M4.1)', () => {
  it('stays process-only and says so without a settings service', async () => {
    const { controller, store } = harness()
    expect(controller.getSnapshot().persistence).toBe('process-only')

    await expect(store.save({ theme: 'no-color' })).resolves.toBe('process-only')
    expect(controller.getSnapshot()).toMatchObject({
      theme: 'no-color',
      warning: expect.stringContaining('not persisted'),
    })
    store.dispose()
  })

  it('treats a read-only provider as process-only rather than promising persistence', async () => {
    const scope = new FakeScope()
    const { controller, store } = harness(scope, false)
    expect(controller.getSnapshot().persistence).toBe('process-only')

    await expect(store.save({ theme: 'high-contrast' })).resolves.toBe('process-only')
    expect(scope.update).not.toHaveBeenCalled()
    expect(controller.getSnapshot().theme).toBe('high-contrast')
    store.dispose()
  })

  it('adopts the stored document and persists a complete section', async () => {
    const scope = new FakeScope({ reducedMotion: true, theme: 'no-color' })
    const { controller, store } = harness(scope)

    expect(controller.getSnapshot()).toMatchObject({
      persistence: 'settings',
      reducedMotion: true,
      theme: 'no-color',
    })

    await expect(store.save({
      keymap: { 'command.palette': 'alt+k' },
      theme: 'high-contrast',
    })).resolves.toBe('applied')
    expect(scope.update).toHaveBeenCalledWith(expect.objectContaining({
      reducedMotion: false,
      theme: 'high-contrast',
    }))
    expect(controller.getSnapshot().keymap['command.palette']).toBe('alt+k')
    expect(controller.getSnapshot().warning).toBeUndefined()
    store.dispose()
  })

  it('rejects an invalid document whole rather than applying it partially', async () => {
    const scope = new FakeScope()
    const { controller, reportError, store } = harness(scope)
    const before = controller.getSnapshot()

    await expect(store.save({
      keymap: { 'command.palette': 'alt+k', 'session.center': 'not-a-chord' },
      theme: 'no-color',
    })).resolves.toBe('rejected')

    expect(scope.update).not.toHaveBeenCalled()
    expect(controller.getSnapshot().keymap).toEqual(before.keymap)
    expect(controller.getSnapshot().theme).toBe('default')
    expect(reportError).toHaveBeenCalled()
    store.dispose()
  })

  it('refuses a keymap collision', async () => {
    const { store } = harness(new FakeScope())
    await expect(store.save({ keymap: { 'jobs.center': 'ctrl+p' } })).resolves.toBe('rejected')
    store.dispose()
  })

  it('applies but warns when the write fails', async () => {
    const scope = new FakeScope()
    scope.update.mockRejectedValue(new Error('settings document is locked'))
    const { controller, reportError, store } = harness(scope)

    await expect(store.save({ theme: 'no-color' })).resolves.toBe('process-only')
    expect(controller.getSnapshot()).toMatchObject({
      theme: 'no-color',
      warning: expect.stringContaining('settings document is locked'),
    })
    expect(reportError).toHaveBeenCalled()
    store.dispose()
  })

  it('adopts an external edit through the watcher', () => {
    const scope = new FakeScope()
    const { controller, store } = harness(scope)

    scope.watcher?.({ reducedMotion: true, theme: 'high-contrast' }, {})
    expect(controller.getSnapshot()).toMatchObject({
      reducedMotion: true,
      theme: 'high-contrast',
    })
    store.dispose()
  })

  it('keeps the last good value when an external edit is invalid', () => {
    const scope = new FakeScope({ theme: 'no-color' })
    const { controller, reportError, store } = harness(scope)
    expect(controller.getSnapshot().theme).toBe('no-color')

    scope.watcher?.({ theme: 'chartreuse' }, {})

    expect(controller.getSnapshot()).toMatchObject({
      theme: 'no-color',
      warning: expect.stringContaining('externally edited'),
    })
    expect(reportError).toHaveBeenCalled()
    store.dispose()
  })

  it('survives a stored document that fails to read', () => {
    const scope = new FakeScope()
    scope.get = () => {
      throw new Error('document unreadable')
    }
    const { controller, reportError, store } = harness(scope)

    expect(controller.getSnapshot().theme).toBe('default')
    expect(reportError).toHaveBeenCalled()
    store.dispose()
  })

  it('unsubscribes on disposal and refuses later writes', async () => {
    const scope = new FakeScope()
    const { store } = harness(scope)

    store.dispose()
    expect(scope.unsubscribes).toBe(1)
    await expect(store.save({ theme: 'no-color' })).resolves.toBe('rejected')
    store.dispose()
  })
})
