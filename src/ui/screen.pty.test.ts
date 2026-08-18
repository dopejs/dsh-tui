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
      screen => screen.some(line => line.includes('How can I help you')),
      'the assistant reply',
    )

    const screen = harness.screen().join('\n')
    expect(screen).toContain('Hi! How can I help you with doper today?')
    expect(screen).not.toContain('Answer briefly')
    expect(screen).toContain('reasoning hidden')
    // The answer stands on its own line, not appended to scratch work.
    expect(screen).not.toContain('Reasoning: The user said hello')
  })

  it('folds an injected reminder onto one line', async () => {
    harness = new ScreenHarness({ scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('system-reminder')),
      'the injected reminder',
    )

    const folded = harness.screen().filter(line => line.includes('system-reminder'))
    expect(folded).toHaveLength(1)
    expect(folded[0]).toContain('expand')
    expect(harness.screen().join('\n')).not.toContain('reminder 12')
  })

  // Nothing may overwrite anything else: a fixed-height layout that clips
  // badly garbles cells, which reads as corruption rather than a bug.
  it('draws every row without overwriting another', async () => {
    harness = new ScreenHarness({ scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('How can I help you')),
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
      screen => screen.some(line => line.includes('How can I help you')),
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

    // The composer keeps its own rows; nothing has been drawn through it.
    const composerTop = screen.findIndex(line => line.startsWith('╭'))
    const composerBottom = screen.findLastIndex(line => line.startsWith('╰'))
    expect(composerTop).toBeGreaterThan(0)
    expect(composerBottom).toBe(composerTop + 2)
    expect(screen[composerTop + 1] ?? '').toContain('›')

    // The status still sits below it, in full.
    expect(screen.slice(composerBottom).join('\n')).toContain('Enter send')

    // And no row is two rows fused together.
    for (const line of screen) {
      const interior = line.slice(1, -1)
      expect(`${line}:${String(interior.includes('╮') || interior.includes('╯'))}`)
        .toBe(`${line}:false`)
    }
  })
})
