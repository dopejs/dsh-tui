import { describe, expect, it } from 'vitest'

import { isMonochrome, toneStyle, type SemanticTone } from './theme'

const TONES: readonly SemanticTone[] = [
  'accent',
  'danger',
  'muted',
  'neutral',
  'positive',
  'warning',
]

describe('semantic theme (M4.1)', () => {
  it('answers every semantic tone for every theme', () => {
    for (const theme of ['default', 'high-contrast', 'no-color'] as const) {
      for (const tone of TONES) {
        expect(() => toneStyle(theme, tone)).not.toThrow()
      }
    }
  })

  it('gives distinct colors to distinct meanings in the default theme', () => {
    const colors = TONES
      .map(tone => toneStyle('default', tone).color)
      .filter((color): color is string => color !== undefined)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('emits no color at all in the no-color theme', () => {
    for (const tone of TONES) {
      expect(toneStyle('no-color', tone)).toEqual({})
    }
    expect(isMonochrome('no-color')).toBe(true)
    expect(isMonochrome('default')).toBe(false)
  })

  // Dimmed text is the first thing to fail a low-vision or low-contrast read.
  it('never dims in the high-contrast theme', () => {
    for (const tone of TONES) {
      expect(toneStyle('high-contrast', tone).dimColor).toBeUndefined()
    }
    expect(toneStyle('default', 'muted').dimColor).toBe(true)
  })

  it('omits absent styling rather than setting it undefined', () => {
    // Spreading a tone must contribute nothing when it styles nothing, which
    // exactOptionalPropertyTypes would otherwise reject at the call site.
    expect(Object.hasOwn(toneStyle('default', 'neutral'), 'color')).toBe(false)
    expect(Object.hasOwn(toneStyle('default', 'danger'), 'dimColor')).toBe(false)
  })

  it('treats an absent tone as no styling', () => {
    expect(toneStyle('default', undefined)).toEqual({})
  })
})
