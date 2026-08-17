import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { ROW_MARKERS, FOCUS_MARKER } from './ink-renderer'

describe('transcript row markers (M6)', () => {
  // A wide marker shifts every following column on that row only, so the
  // transcript stops aligning exactly where the eye scans it.
  it('is exactly one cell wide for every role', () => {
    for (const [role, marker] of Object.entries(ROW_MARKERS)) {
      expect(`${role}:${String(stringWidth(marker))}`).toBe(`${role}:1`)
    }
    expect(stringWidth(FOCUS_MARKER.trim())).toBe(1)
  })

  it('gives every role a distinct marker', () => {
    const markers = Object.values(ROW_MARKERS)
    expect(new Set(markers).size).toBe(markers.length)
  })

  // A focused user row would otherwise render the same glyph twice.
  it('does not reuse the focus glyph for a role', () => {
    expect(Object.values(ROW_MARKERS)).not.toContain(FOCUS_MARKER.trim())
  })
})
