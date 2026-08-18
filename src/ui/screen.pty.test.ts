import { afterEach, describe, expect, it } from 'vitest'

import { ScreenHarness } from '../../test-fixtures/screen-harness'

const onPosix = process.platform === 'win32' ? describe.skip : describe

let harness: ScreenHarness | undefined
afterEach(() => {
  harness?.dispose()
  harness = undefined
})

onPosix('the interface, on a real terminal (M6.10)', () => {
  it('takes the alternate screen', async () => {
    harness = new ScreenHarness({ scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('command palette')),
      'the composer hint',
    )
    expect(harness.onAlternateScreen()).toBe(true)
  })

  // The caret was invisible for a whole release because the cursor token
  // carried a block glyph and was then inverted, painting it in the background
  // colour. No text assertion can see that; the cell attribute can.
  it('draws a visible caret at the cursor while typing', async () => {
    harness = new ScreenHarness({ scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('command palette')),
      'the composer hint',
    )

    harness.type('hello')
    await harness.waitFor(
      screen => screen.some(line => line.includes('hello')),
      'the typed text',
    )
    await harness.settle()

    const screen = harness.screen()
    const composerRow = screen.findIndex(line => line.includes('hello'))
    const caret = harness.invertedCells().filter(cell => cell.row === composerRow)

    // Exactly one caret, sitting immediately after what was typed. Asserting
    // the inversion is the point: the glyph alone was there through a whole
    // release in which the caret was invisible.
    expect(caret).toHaveLength(1)
    const typedEnd = (screen[composerRow] ?? '').indexOf('hello') + 'hello'.length
    expect(caret[0]?.column).toBe(typedEnd)

    // Inversion alone is not visibility. Inverting a cell swaps foreground and
    // background, so a glyph that already fills the cell -- a full block --
    // ends up painted in the background colour and disappears. The caret must
    // sit on a cell whose glyph inversion can actually reveal.
    const glyph = harness.characterAt(caret[0]?.row ?? 0, caret[0]?.column ?? 0)
    expect(`caret glyph: ${JSON.stringify(glyph)}`).toBe('caret glyph: " "')
  })

  it('shows the answer, not the reasoning, when a turn completes', async () => {
    harness = new ScreenHarness({ scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )

    const screen = harness.screen().join('\n')
    expect(screen).toContain('Hi! I am in the doper workspace.')
    expect(screen).not.toContain('Answer briefly')
    expect(screen).toContain('reasoning hidden')
    // The answer stands on its own line, not appended to scratch work.
    expect(screen).not.toContain('Reasoning: The user said hello')
  })

  // The user reads the conversation, not what the host injected on their
  // behalf. Withheld, never discarded: the status says how much is being held
  // back, and the palette draws it inline again.
  it('withholds injected context, and brings it back on request', async () => {
    harness = new ScreenHarness({ rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    expect(harness.screen().join('\n')).not.toContain('system-reminder')
    expect(harness.screen().join('\n')).toContain('context hidden')

    // Ctrl-P, search, enter -- the way a user reaches it.
    harness.type('\u0010')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Command palette')),
      'the command palette',
    )
    harness.type('injected context')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Toggle injected context')),
      'the toggle action',
    )
    harness.type('\r')

    await harness.waitFor(
      screen => screen.some(line => line.includes('system-reminder')),
      'the injected reminder drawn inline',
    )
    // Drawn as one folded line, not as forty.
    const folded = harness.screen().filter(line => line.includes('system-reminder'))
    expect(folded).toHaveLength(1)
    expect(harness.screen().join('\n')).not.toContain('reminder 12')
  })

  // Every row began the same way, so finding where an exchange started meant
  // reading rather than looking. A user turn is a band across the full width.
  it('marks the user turn with a band across the terminal', async () => {
    harness = new ScreenHarness({ columns: 60, rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    const screen = harness.screen()
    const userRow = screen.findIndex(line => line.includes('hello'))
    expect(userRow).toBeGreaterThanOrEqual(0)

    const banded = harness.bandedCells().filter(cell => cell.row === userRow)
    expect(banded).toHaveLength(60)

    // A raised background, not an inversion: inverting the row is the loudest
    // thing a terminal can do, and it reads as glare on an ordinary turn.
    expect(harness.invertedCells().filter(cell => cell.row === userRow)).toHaveLength(0)

    // And the reply is not banded, or the distinction would say nothing.
    const answerRow = screen.findIndex(line => line.includes('I am in the doper workspace'))
    expect(harness.bandedCells().filter(cell => cell.row === answerRow)).toHaveLength(0)
  })

  // Nothing may overwrite anything else: a fixed-height layout that clips
  // badly garbles cells, which reads as corruption rather than a bug.
  it('draws every row without overwriting another', async () => {
    harness = new ScreenHarness({ scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    const screen = harness.screen()
    // A garbled screen shows fragments of two lines fused into one, which
    // reliably produces a border glyph in the middle of prose.
    for (const line of screen) {
      const interior = line.slice(1, -1)
      expect(`${line}:${String(interior.includes('╮') || interior.includes('╯'))}`)
        .toBe(`${line}:false`)
    }
  })

  // Taking the alternate screen without filling it is not fullscreen: the
  // buffer is swapped and the layout never notices, so the composer floats
  // wherever the conversation happens to end and the bottom of the terminal is
  // dead space.
  it('fills the terminal, with the composer at the bottom', async () => {
    harness = new ScreenHarness({ rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    const screen = harness.screen()
    const lastDrawn = screen.reduce(
      (last, line, index) => (line.trim() === '' ? last : index),
      -1,
    )
    // The last drawn row is the bottom of the screen, give or take the one row
    // a terminal keeps for its own cursor.
    expect(lastDrawn).toBeGreaterThanOrEqual(screen.length - 2)

    const composerBottom = screen.findLastIndex(line => line.startsWith('╰'))
    const hint = screen.findIndex(line => line.includes('Enter send'))
    expect(composerBottom).toBeGreaterThan(0)
    expect(hint).toBeGreaterThan(composerBottom)
  })

  // The danger in pinning a layout to the viewport: content taller than the
  // space it was given overwrites whatever is drawn below it. A garbled screen
  // reads as corruption, which is worse than the dead space it replaced.
  it('clips a conversation taller than the terminal without garbling it', async () => {
    harness = new ScreenHarness({ rows: 24, scenario: 'overflow' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('of a long conversation')),
      'the long conversation',
    )
    await harness.settle()

    const screen = harness.screen()

    // The composer keeps its own three rows, and nothing is drawn through
    // them. Checking only for a border glyph in a line's interior missed the
    // real failure, where the border and the input line fused and the closing
    // glyph landed at the end of the row where it always belongs.
    const composerTop = screen.findIndex(line => line.startsWith('╭'))
    const composerBottom = screen.findLastIndex(line => line.startsWith('╰'))
    expect(composerTop).toBeGreaterThan(0)
    expect(composerBottom).toBe(composerTop + 2)
    expect(screen[composerTop] ?? '').not.toContain('›')
    expect(screen[composerBottom] ?? '').not.toContain('›')
    expect(screen[composerTop + 1] ?? '').toContain('›')

    // The status still sits below it, in full: identity on one line, position
    // on the next, neither fused with the other.
    const status = screen.slice(composerBottom + 1)
    expect(status.join('\n')).toContain('Enter send')
    const identity = status.find(line => line.includes('dsh-tui ·')) ?? ''
    expect(identity).not.toContain('transcript ')

    // And no row is two rows fused together.
    for (const line of screen) {
      const interior = line.slice(1, -1)
      expect(`${line}:${String(interior.includes('╮') || interior.includes('╯'))}`)
        .toBe(`${line}:false`)
    }
  })

  // The fold marker used to be drawn between the answer's first line and the
  // rest of it, cutting one reply in half around a note about scratch work.
  // Reasoning comes first in the durable log, and it reads that way too: the
  // deliberation above, the answer whole and contiguous below.
  it('keeps the answer contiguous, with reasoning above it', async () => {
    harness = new ScreenHarness({ rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    const screen = harness.screen()
    const fold = screen.findIndex(line => line.includes('reasoning hidden'))
    const answerStart = screen.findIndex(line => line.includes('I am in the doper workspace'))
    const answerEnd = screen.findIndex(line => line.includes('would you like to work on'))

    expect(fold).toBeGreaterThanOrEqual(0)
    expect(answerStart).toBeGreaterThanOrEqual(0)
    expect(answerEnd).toBeGreaterThan(answerStart)
    // Above the answer, and not inside it.
    expect(fold).toBeLessThan(answerStart)
  })

  // A turn that paused for four seconds and one that answered instantly are
  // not the same event, and the transcript should not read as though they
  // were. The figure comes from the durable event times, so a resumed session
  // reports what it reported live.
  it('reports how long the model thought', async () => {
    harness = new ScreenHarness({ rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    const fold = harness.screen().find(line => line.includes('reasoning hidden')) ?? ''
    expect(fold).toContain('thought for 4.2s')
  })

  // Packed edge to edge the transcript reads as one block of text, with
  // nowhere for the eye to rest between one turn and the next.
  it('separates turns with a blank line', async () => {
    harness = new ScreenHarness({ rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('would you like to work on')),
      'the assistant reply',
    )
    await harness.settle()

    const screen = harness.screen()
    const userRow = screen.findIndex(line => line.includes('hello'))
    const assistantRow = screen.findIndex(line => line.includes('reasoning hidden'))

    expect(userRow).toBeGreaterThanOrEqual(0)
    expect(assistantRow).toBeGreaterThan(userRow + 1)
    expect((screen[assistantRow - 1] ?? 'x').trim()).toBe('')
  })
})
