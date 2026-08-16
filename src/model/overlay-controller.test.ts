import { describe, expect, it, vi } from 'vitest'

import { OverlayController, resolveInputSurface } from './overlay-controller'

describe('OverlayController (M1.3)', () => {
  it('owns one replaceable overlay and closes only the expected layer', () => {
    const controller = new OverlayController()
    const listener = vi.fn()
    controller.subscribe(listener)

    expect(controller.open('command-palette')).toBe(true)
    expect(controller.open('command-palette')).toBe(false)
    expect(controller.open('completion')).toBe(true)
    expect(controller.close('command-palette')).toBe(false)
    expect(controller.close('completion')).toBe(true)
    expect(controller.getSnapshot()).toEqual({ revision: 3 })
    expect(listener).toHaveBeenCalledTimes(3)

    controller.dispose()
    expect(() => controller.open('command-palette')).toThrow('disposed')
  })

  it('resolves the documented exclusive input priority without discarding overlays', () => {
    const controller = new OverlayController()
    expect(resolveInputSurface(controller.getSnapshot(), {
      interactionActive: false,
      searchOpen: false,
    })).toBe('composer')

    controller.open('command-palette')
    expect(resolveInputSurface(controller.getSnapshot(), {
      interactionActive: false,
      searchOpen: true,
    })).toBe('overlay')
    expect(resolveInputSurface(controller.getSnapshot(), {
      interactionActive: true,
      searchOpen: true,
    })).toBe('interaction')
    expect(controller.getSnapshot().active).toBe('command-palette')

    controller.close()
    expect(resolveInputSurface(controller.getSnapshot(), {
      interactionActive: false,
      searchOpen: true,
    })).toBe('transcript-search')
    controller.dispose()
  })
})
