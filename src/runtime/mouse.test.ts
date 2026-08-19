import { describe, expect, it } from 'vitest'

import { DISABLE_MOUSE, ENABLE_MOUSE, parseMouse } from './mouse'

// Built from the code point, never written as a bare character: an
// escape lost in an edit leaves the fixture and the expectation equally
// wrong, and the comparison green.
const ESC = String.fromCodePoint(0x1b)

/** A report as a terminal sends it: coordinates one-based. */
function report(button: number, column: number, row: number, final: 'M' | 'm' = 'M'): string {
  return `${ESC}[<${String(button)};${String(column)};${String(row)}${final}`
}

describe('mouse mode sequences (M7.1)', () => {
  // Asserted by code point. Written as a bare character in both the constant
  // and the expectation, an escape that went missing would leave the two
  // equally wrong and the comparison green.
  it('actually carries the escape character', () => {
    expect(ESC.codePointAt(0)).toBe(0x1b)
    expect(ENABLE_MOUSE.codePointAt(0)).toBe(0x1b)
    expect(DISABLE_MOUSE.codePointAt(0)).toBe(0x1b)
  })

  it('asks for SGR reporting and turns it off in the reverse order', () => {
    expect(ENABLE_MOUSE).toBe(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`)
    expect(DISABLE_MOUSE).toBe(`${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`)
  })

  // A terminal left reporting prints escape sequences into the user's shell on
  // every click, long after the process that asked for it is gone.
  it('turns off everything it turned on', () => {
    for (const mode of ['1000', '1002', '1006']) {
      expect(`${mode}:${String(ENABLE_MOUSE.includes(`${mode}h`))}`).toBe(`${mode}:true`)
      expect(`${mode}:${String(DISABLE_MOUSE.includes(`${mode}l`))}`).toBe(`${mode}:true`)
    }
  })
})

describe('parseMouse (M7.1)', () => {
  it('decodes a press and a release, zero-based', () => {
    expect(parseMouse(report(0, 12, 5)).events)
      .toEqual([{ column: 11, kind: 'press', row: 4 }])
    expect(parseMouse(report(0, 12, 5, 'm')).events)
      .toEqual([{ column: 11, kind: 'release', row: 4 }])
  })

  it('decodes the wheel in both directions', () => {
    expect(parseMouse(report(64, 1, 1)).events)
      .toEqual([{ column: 0, kind: 'wheel-up', row: 0 }])
    expect(parseMouse(report(65, 1, 1)).events)
      .toEqual([{ column: 0, kind: 'wheel-down', row: 0 }])
  })

  // X10 encoding stops reporting above column 223, which a full-width terminal
  // reaches. SGR is unbounded, and a click on the right of a wide terminal must
  // land where it was made rather than somewhere in the middle.
  it('decodes coordinates past the single-byte limit', () => {
    expect(parseMouse(report(0, 400, 120)).events)
      .toEqual([{ column: 399, kind: 'press', row: 119 }])
  })

  it('hands back everything that was not a mouse report', () => {
    const parsed = parseMouse(`abc${report(0, 2, 3)}def`)
    expect(parsed.rest).toBe('abcdef')
    expect(parsed.events).toHaveLength(1)
  })

  it('decodes several reports arriving in one read', () => {
    const parsed = parseMouse(`${report(65, 1, 1)}${report(65, 1, 1)}${report(0, 4, 4)}`)
    expect(parsed.events.map(event => event.kind))
      .toEqual(['wheel-down', 'wheel-down', 'press'])
    expect(parsed.rest).toBe('')
  })

  // Typed text must survive: an escape sequence read as typing puts `[<0;1;1M`
  // in the composer.
  it('leaves ordinary typing alone', () => {
    const parsed = parseMouse('hello')
    expect(parsed.events).toEqual([])
    expect(parsed.rest).toBe('hello')
  })

  it('ignores motion reports it never asked for', () => {
    expect(parseMouse(report(32, 5, 5)).events).toEqual([])
    expect(parseMouse(report(35, 5, 5)).events).toEqual([])
  })

  // A coordinate of zero cannot be turned zero-based without going negative,
  // and a negative row would index the wrong end of the transcript.
  it('drops a malformed coordinate rather than wrapping it', () => {
    expect(parseMouse(report(0, 0, 5)).events).toEqual([])
    expect(parseMouse(report(0, 5, 0)).events).toEqual([])
  })

  it('is not confused by a partial sequence', () => {
    const parsed = parseMouse(`${ESC}[<0;5`)
    expect(parsed.events).toEqual([])
    expect(parsed.rest).toBe(`${ESC}[<0;5`)
  })
})
