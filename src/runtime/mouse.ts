/**
 * Mouse reporting.
 *
 * Ink 7 exposes no mouse API at all, so the protocol is handled here: ask the
 * terminal to report, decode what it sends, and stop asking on the way out.
 *
 * SGR encoding (`?1006`) is the only mode used. The original X10 encoding packs
 * coordinates into single bytes and silently stops above column 223, which a
 * full-width terminal reaches; SGR is unbounded and reports button release
 * distinctly, so a click can be recognised without guessing.
 *
 * Nothing here touches a terminal. It builds the sequences a caller writes and
 * decodes the bytes a caller reads, so every rule below is testable without a
 * TTY.
 */

/** Ask the terminal to report button presses, releases, and the wheel. */
export const ENABLE_MOUSE = '\u001b[?1000h\u001b[?1006h'

/**
 * Stop reporting, in the reverse order.
 *
 * A terminal left reporting after exit prints escape sequences into the user's
 * shell whenever they click, which looks like a corrupted terminal and outlives
 * the process that caused it.
 */
export const DISABLE_MOUSE = '\u001b[?1006l\u001b[?1000l'

export type MouseEventKind = 'press' | 'release' | 'wheel-down' | 'wheel-up'

export interface MouseEvent {
  /** Terminal column, zero-based. */
  readonly column: number
  readonly kind: MouseEventKind
  /** Terminal row, zero-based. */
  readonly row: number
}

export interface MouseParse {
  readonly events: readonly MouseEvent[]
  /**
   * Input with the mouse reports removed, so the caller can pass the rest on to
   * key handling that would otherwise read escape sequences as typing.
   */
  readonly rest: string
}

// ESC [ < button ; column ; row (M|m).
//
// `no-control-regex` guards against control characters slipping into a pattern
// unnoticed. Here the escape is the pattern: a mouse report is defined by it,
// and matching anything less would also match the literal text `[<0;1;1M`
// typed into the composer.
// eslint-disable-next-line no-control-regex -- matching ESC is the whole point
const SGR = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/gu

const WHEEL_UP = 64
const WHEEL_DOWN = 65
const MOTION_BIT = 32
const BUTTON_MASK = 3

function kindOf(button: number, final: string): MouseEventKind | undefined {
  // The wheel reports as a press with bit 6 set, and never reports a release.
  if (button === WHEEL_UP) return 'wheel-up'
  if (button === WHEEL_DOWN) return 'wheel-down'
  // Motion reporting is not asked for, and `3` in the button bits is the
  // "no button" release form that says nothing about which button was let go.
  if ((button & MOTION_BIT) !== 0) return undefined
  if ((button & BUTTON_MASK) === BUTTON_MASK) return undefined
  return final === 'M' ? 'press' : 'release'
}

/**
 * Decode every mouse report in `input`.
 *
 * Coordinates arrive one-based and are returned zero-based, matching the row
 * and column indices a renderer works in. A report with a coordinate of zero is
 * malformed and is dropped rather than wrapped around to a negative position.
 */
export function parseMouse(input: string): MouseParse {
  const events: MouseEvent[] = []
  let rest = ''
  let index = 0
  SGR.lastIndex = 0
  for (let match = SGR.exec(input); match !== null; match = SGR.exec(input)) {
    rest += input.slice(index, match.index)
    index = match.index + match[0].length
    const kind = kindOf(Number(match[1]), match[4] as string)
    const column = Number(match[2])
    const row = Number(match[3])
    if (kind === undefined || column < 1 || row < 1) continue
    events.push(Object.freeze({ column: column - 1, kind, row: row - 1 }))
  }
  rest += input.slice(index)
  return Object.freeze({ events: Object.freeze(events), rest })
}
