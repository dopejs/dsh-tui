import { describe, expect, it } from 'vitest'

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
})
