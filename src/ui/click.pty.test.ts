import { afterEach, describe, expect, it } from 'vitest'

import { ScreenHarness } from '../../test-fixtures/screen-harness'

const onPosix = process.platform === 'win32' ? describe.skip : describe

let harness: ScreenHarness | undefined
afterEach(() => {
  harness?.dispose()
  harness = undefined
})

/**
 * Clicking, which is what the mouse was wanted for.
 *
 * Wheel events were decoded and acted on; presses were decoded and delivered
 * to nothing. Shipping that as mouse support meant the one gesture that was
 * asked for -- click the fold to open the reasoning -- had never been written.
 */
onPosix('clicking (M7.8)', () => {
  it('opens folded reasoning when its line is clicked', async () => {
    harness = new ScreenHarness({ columns: 80, rows: 24, scenario: 'conversation' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('reasoning hidden')),
      'the folded reasoning',
    )
    await harness.settle()

    const fold = harness.screen().findIndex(line => line.includes('reasoning hidden'))
    harness.click(fold, 10)
    await harness.waitFor(
      screen => screen.some(line => line.includes('The user said hello')),
      'the reasoning drawn in full',
    )

    // Clicking the reasoning folds it back: expanded, there is no fold line
    // left to aim at.
    const expanded = harness.screen().findIndex(line => line.includes('The user said hello'))
    harness.click(expanded, 10)
    await harness.waitFor(
      screen => !screen.some(line => line.includes('The user said hello')),
      'the reasoning folded again',
    )
  }, 30_000)

  it('moves the caret when the composer is clicked', async () => {
    harness = new ScreenHarness({ columns: 80, rows: 24, scenario: 'empty' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('Try "explain')),
      'the composer hint',
    )
    harness.type('hello world')
    await harness.waitFor(
      screen => screen.some(line => line.includes('hello world')),
      'the typed text',
    )
    await harness.settle()

    const screen = harness.screen()
    const row = screen.findIndex(line => line.includes('hello world'))
    const target = (screen[row] ?? '').indexOf('world')
    harness.click(row, target)
    await harness.settle()

    // The caret moved to the clicked cell rather than staying at the end.
    const caret = harness.invertedCells()[0]
    expect(caret?.row).toBe(row)
    expect(caret?.column).toBe(target)
  }, 30_000)
})
