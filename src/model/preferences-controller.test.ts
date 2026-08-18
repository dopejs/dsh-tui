import { describe, expect, it, vi } from 'vitest'

import { PreferencesController } from './preferences-controller'

describe('PreferencesController (M1.5)', () => {
  it('falls back atomically when startup preferences are invalid', () => {
    const preferences = new PreferencesController({ theme: 'broken' })
    expect(preferences.getSnapshot()).toMatchObject({
      keymap: { 'command.palette': 'ctrl+p' },
      theme: 'default',
      warning: 'unsupported theme',
    })
  })

  it('rejects collisions without changing the active keymap', () => {
    const preferences = new PreferencesController()
    const before = preferences.getSnapshot()
    expect(preferences.replace({
      keymap: { 'session.center': 'ctrl+p' },
    })).toMatchObject({ kind: 'rejected', error: 'keymap collision: ctrl+p' })
    expect(preferences.getSnapshot()).toBe(before)
  })

  it('applies a valid complete override and resolves actions', () => {
    const preferences = new PreferencesController()
    expect(preferences.replace({
      keymap: { 'session.center': 'alt+s' },
      theme: 'no-color',
    })).toEqual({ kind: 'applied' })
    expect(preferences.actionForChord('alt+s')).toBe('session.center')
    expect(preferences.getSnapshot()).toMatchObject({ revision: 1, theme: 'no-color' })
  })

  it('accepts the accessibility modes and rejects non-boolean values', () => {
    const controller = new PreferencesController({
      reducedMotion: true,
      screenReader: true,
      theme: 'high-contrast',
    })
    expect(controller.getSnapshot()).toMatchObject({
      reducedMotion: true,
      screenReader: true,
      theme: 'high-contrast',
    })

    expect(controller.replace({ screenReader: 'yes' }))
      .toMatchObject({ kind: 'rejected' })
    expect(controller.replace({ reducedMotion: 1 }))
      .toMatchObject({ kind: 'rejected' })
    // A rejected document changes nothing.
    expect(controller.getSnapshot().screenReader).toBe(true)
  })

  it('reports where preferences are kept', () => {
    const controller = new PreferencesController()
    expect(controller.getSnapshot().persistence).toBe('process-only')
    controller.setPersistence('settings')
    expect(controller.getSnapshot().persistence).toBe('settings')
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const controller = new PreferencesController()
    const listener = vi.fn()
    const stop = controller.subscribe(listener)
    controller.replace({ theme: 'no-color' })
    expect(listener).toHaveBeenCalledOnce()
    stop()
    controller.replace({ theme: 'default' })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('accepts both render modes and rejects anything else', () => {
    expect(new PreferencesController({ renderMode: 'inline' }).getSnapshot().renderMode)
      .toBe('inline')
    expect(new PreferencesController().getSnapshot().renderMode).toBe('alternate')

    const controller = new PreferencesController()
    expect(controller.replace({ renderMode: 'fullscreen' }))
      .toMatchObject({ error: 'unsupported renderMode', kind: 'rejected' })
    // A rejected document changes nothing.
    expect(controller.getSnapshot().renderMode).toBe('alternate')
  })
})

