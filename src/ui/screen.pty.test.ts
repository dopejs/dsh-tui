import { afterEach, describe, expect, it } from 'vitest'

import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISABLE_MOUSE, ENABLE_MOUSE } from '../runtime/mouse'
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
      screen => screen.some(line => line.includes('/ for commands')),
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
      screen => screen.some(line => line.includes('/ for commands')),
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

  // Ink 7 has no mouse API, so the terminal is asked to report and the reports
  // are decoded here. The proof is that a wheel notch moves the transcript,
  // on a real terminal, and that the sequence never reaches the composer.
  it('scrolls the transcript with the wheel', async () => {
    harness = new ScreenHarness({ rows: 20, scenario: 'overflow' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('turn 59 of a long conversation')),
      'the tail of the conversation',
    )
    await harness.settle()

    const tail = harness.screen().join('\n')
    expect(tail).toContain('turn 59 of a long conversation')

    harness.wheel('up')
    harness.wheel('up')
    await harness.waitFor(
      screen => !screen.some(line => line.includes('turn 59 of a long conversation')),
      'the transcript to scroll back',
    )

    // Scrolled away from the tail, and the report never reached the composer.
    // The composer is found by its own hint: `›` also marks the focused
    // transcript row once scrolling detaches the viewport, so looking for the
    // glyph finds the wrong line.
    const scrolled = harness.screen()
    expect(scrolled.join('\n')).not.toContain('[<')
    expect(scrolled.some(line => line.includes('Try "explain this repository"'))).toBe(true)

    harness.wheel('down')
    harness.wheel('down')
    await harness.waitFor(
      screen => screen.some(line => line.includes('turn 59 of a long conversation')),
      'the transcript to return to the tail',
    )
  }, 30_000)

  // The consequential half of mouse support. A terminal left reporting prints
  // escape sequences into the user's shell on every click afterwards -- it
  // looks like a corrupted terminal, and it outlives the process that caused
  // it. Asserted after a real exit, because nothing on screen can show it.
  it('stops the terminal reporting before it exits', async () => {
    harness = new ScreenHarness({ rows: 20, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )
    await harness.waitForOutput(ENABLE_MOUSE, 'the request to start reporting')

    // Through the palette, which is the path a user has: Ctrl-P, search, Enter.
    harness.type('\u0010')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Command palette')),
      'the command palette',
    )
    // A single word, typed as one write: filtering runs per keystroke, and a
    // phrase with a space gives the list more chances to be mid-update when
    // Enter arrives. This test was intermittently red for exactly that reason.
    harness.type('exit')
    await harness.waitFor(
      screen => screen.some(line => line.includes('› Exit TUI')),
      'the exit action to be the selected one',
    )
    // The action appearing and the action being selected are different
    // moments. Pressing Enter on the first made this fail on Linux with Node
    // 24 roughly one run in two, which is worse than no gate: a flaky red
    // teaches you to re-run it.
    await harness.settle()
    harness.type('\r')
    const code = await harness.waitForExit()

    expect(code).toBe(0)
    expect(harness.rawOutput()).toContain(DISABLE_MOUSE)
  }, 30_000)

  /*
   * The caret drawn in the composer is an inverted cell, which a person can
   * see and an input method cannot. A composing character -- half-typed pinyin
   * -- is drawn by the terminal at the hardware cursor, so if that sits
   * anywhere else, the text being composed appears outside the composer.
   */
  it('puts the terminal cursor on the caret, where an IME will compose', async () => {
    harness = new ScreenHarness({ columns: 60, rows: 20, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )

    harness.type('nihao')
    await harness.waitFor(
      screen => screen.some(line => line.includes('nihao')),
      'the typed text',
    )
    await harness.settle()

    const screen = harness.screen()
    const caret = harness.invertedCells()
    const cursor = harness.cursor()

    expect(caret).toHaveLength(1)
    expect(cursor).toEqual({ column: caret[0]?.column, row: caret[0]?.row })

    // And that is inside the composer's box, not on some line below it.
    const top = screen.findIndex(line => line.startsWith('╭'))
    const bottom = screen.findLastIndex(line => line.startsWith('╰'))
    expect(cursor.row).toBeGreaterThan(top)
    expect(cursor.row).toBeLessThan(bottom)
  }, 30_000)

  // The case an input method actually produces. A CJK character occupies two
  // cells, so counting characters instead of cells drifts the cursor left by
  // one cell for every wide character already committed -- and the composing
  // text lands on top of what was typed before it.
  it('keeps the cursor on the caret after wide characters', async () => {
    harness = new ScreenHarness({ columns: 60, rows: 20, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )

    harness.type('\u4f60\u597d\u4e16\u754c')
    await harness.waitFor(
      screen => screen.some(line => line.includes('\u4f60\u597d')),
      'the typed text',
    )
    await harness.settle()

    const caret = harness.invertedCells()
    expect(caret).toHaveLength(1)
    expect(harness.cursor()).toEqual({ column: caret[0]?.column, row: caret[0]?.row })
  }, 30_000)

  /*
   * Mouse reporting is asked for after the alternate screen is taken.
   *
   * Terminals keep private mode state per screen buffer, so a mode set on the
   * primary screen is not in effect once the alternate one is entered. Asked
   * for first, mouse reporting was silently discarded on a real terminal --
   * Ghostty reported nothing at all -- while this emulator, which does not
   * separate the buffers, kept it and stayed green.
   */
  it('asks for mouse reporting only after taking the alternate screen', async () => {
    harness = new ScreenHarness({ rows: 20, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )

    await harness.waitForOutput(ENABLE_MOUSE, 'the request to start reporting')
    const raw = harness.rawOutput()
    const alternateScreen = raw.indexOf('[?1049h')
    const reporting = raw.indexOf(ENABLE_MOUSE)

    expect(alternateScreen).toBeGreaterThanOrEqual(0)
    expect(reporting).toBeGreaterThanOrEqual(0)
    expect(reporting).toBeGreaterThan(alternateScreen)
  }, 30_000)

  // Reporting takes text selection away: while it is on, the terminal hands
  // mouse events here instead of making a selection of its own. Shift bypasses
  // that on most terminals but not all, so it can be handed back outright.
  it('hands mouse reporting back on request', async () => {
    harness = new ScreenHarness({ rows: 20, scenario: 'overflow' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('turn 59 of a long conversation')),
      'the tail of the conversation',
    )

    harness.type('\u0010')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Command palette')),
      'the command palette',
    )
    harness.type('mouse')
    await harness.waitFor(
      screen => screen.some(line => line.includes('\u203a Toggle mouse reporting')),
      'the toggle to be selected',
    )
    await harness.settle()
    harness.type('\r')
    await harness.waitFor(
      screen => screen.some(line => line.includes('selects text again')),
      'the confirmation',
    )

    // The terminal was actually told to stop, and the wheel no longer moves
    // the transcript.
    expect(harness.rawOutput()).toContain(DISABLE_MOUSE)
    const before = harness.screen().join('\n')
    harness.wheel('up')
    harness.wheel('up')
    await harness.settle()
    expect(harness.screen().join('\n')).toBe(before)
  }, 30_000)

  /*
   * Shift-Enter inserts a newline, which is what every chat surface does and
   * what Claude Code does.
   *
   * Terminals send the same byte for Enter and Shift-Enter, so the two cannot
   * be told apart without the Kitty keyboard protocol. The emulator here does
   * not speak it, so a terminal that does -- Ghostty, Kitty, WezTerm -- is
   * impersonated by answering the capability query.
   */
  it('inserts a newline on Shift-Enter where the terminal reports it', async () => {
    harness = new ScreenHarness({ columns: 60, kittyKeyboard: true, rows: 20, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )

    harness.type('first')
    await harness.waitFor(
      screen => screen.some(line => line.includes('first')),
      'the first line',
    )
    harness.shiftEnter()
    harness.type('second')
    await harness.waitFor(
      screen => screen.some(line => line.includes('second')),
      'the second line',
    )
    await harness.settle()

    const screen = harness.screen()
    const first = screen.findIndex(line => line.includes('first'))
    const second = screen.findIndex(line => line.includes('second'))

    // Two lines of one draft, and nothing was sent.
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBe(first + 1)
    expect(screen.join('\n')).not.toContain('Try "explain this repository"')

    /*
     * And the terminal was actually asked to disambiguate.
     *
     * Ink's parser understands `CSI 13;2u` whether or not the protocol is on,
     * so feeding that sequence proves only that the parser works. A real
     * terminal never sends it unless asked: without this assertion, disabling
     * the protocol outright left every one of these tests green.
     */
    await harness.waitForOutput(
      `${String.fromCodePoint(0x1b)}[>1u`,
      'the request to disambiguate escape codes',
    )
  }, 30_000)

  // The other half of the same claim: a terminal that stays silent is not
  // asked to do anything, because it would not understand the request.
  it('does not ask a terminal that never answered the query', async () => {
    harness = new ScreenHarness({ columns: 60, rows: 20, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )
    await harness.settle()
    expect(harness.rawOutput()).not.toContain(`${String.fromCodePoint(0x1b)}[>1u`)
  }, 30_000)

  // And the capability reply is never typed, whether or not it is awaited.
  it('never lets the capability reply reach the composer', async () => {
    harness = new ScreenHarness({ columns: 60, kittyKeyboard: true, rows: 20, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('/ for commands')),
      'the composer hint',
    )
    harness.type('hello')
    await harness.waitFor(
      screen => screen.some(line => line.includes('hello')),
      'the typed text',
    )
    await harness.settle()

    const composer = harness.screen().find(line => line.includes('\u203a hello')) ?? ''
    expect(composer).toContain('hello')
    expect(composer).not.toContain('?1u')
    expect(composer).not.toContain('hellohello')
  }, 30_000)

  /*
   * Three causes look identical from inside the interface: a terminal that
   * reports nothing, one that reports something unrecognised, and one whose
   * reports nothing acts on. The log tells them apart in a single run, which
   * is the difference between diagnosing this and guessing at it.
   */
  it('records raw terminal input when asked to', async () => {
    const logPath = join(tmpdir(), `dsh-tui-input-${String(process.pid)}.log`)
    rmSync(logPath, { force: true })
    harness = new ScreenHarness({
      environment: { DSH_TUI_INPUT_LOG: logPath },
      rows: 20,
      scenario: 'overflow',
    })
    await harness.waitFor(
      screen => screen.some(line => line.includes('of a long conversation')),
      'the conversation',
    )
    harness.wheel('up')
    harness.type('x')
    await harness.settle()

    const recorded = readFileSync(logPath, 'utf8')
    // Both what a terminal sends for the wheel and what it sends for a key.
    expect(recorded).toContain('[<64;')
    expect(recorded).toContain('x')
    rmSync(logPath, { force: true })
  }, 30_000)
})
