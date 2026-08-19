import { afterEach, describe, expect, it } from 'vitest'

import { ScreenHarness } from '../../test-fixtures/screen-harness'

const onPosix = process.platform === 'win32' ? describe.skip : describe

let harness: ScreenHarness | undefined
afterEach(() => {
  harness?.dispose()
  harness = undefined
})

/**
 * Where the terminal draws a composing character.
 *
 * An input method has no idea where the caret is drawn -- that is an inverted
 * cell, which only a person can see. It draws at the hardware cursor. So the
 * one thing that has to hold, in every state the composer can be in, is that
 * the two are the same cell.
 *
 * Typing from an empty composer is the easiest of those states and the only one
 * that was covered. Inserting into the middle of a line, a second line, a line
 * long enough to be cropped, and wide characters on either side of the cursor
 * are all ordinary, and none of them were.
 */
async function openComposer(options: { columns?: number } = {}): Promise<ScreenHarness> {
  const created = new ScreenHarness({
    columns: options.columns ?? 60,
    rows: 20,
    scenario: 'empty',
  })
  await created.waitFor(
    // A short marker: the full hint is truncated on a narrow terminal, and one
    // of these cases deliberately uses one.
    screen => screen.some(line => line.includes('Try "explain')),
    'the composer hint',
  )
  return created
}

/**
 * The caret's leftmost cell.
 *
 * A wide character under the caret inverts both of its cells, so counting one
 * inverted cell is wrong wherever an input method is most likely to be used.
 * What has to hold is that the terminal's cursor sits at the caret's left edge.
 */
function caretAndCursor(instance: ScreenHarness) {
  const cells = [...instance.invertedCells()].sort(
    (left, right) => left.row - right.row || left.column - right.column,
  )
  return { caret: cells[0], cursor: instance.cursor() }
}

onPosix('the cursor an input method composes at (M7.3)', () => {
  it('follows the caret into the middle of a line', async () => {
    harness = await openComposer()
    harness.type('abcdef')
    await harness.waitFor(screen => screen.some(l => l.includes('abcdef')), 'the text')

    harness.key('left')
    harness.key('left')
    await harness.settle()

    const { caret, cursor } = caretAndCursor(harness)
    expect(caret).toBeDefined()
    expect(cursor).toEqual(caret)
  }, 30_000)

  it('follows the caret onto a second line', async () => {
    harness = await openComposer()
    harness.type('first')
    await harness.waitFor(screen => screen.some(l => l.includes('first')), 'the first line')
    harness.key('ctrl-j')
    harness.type('second')
    await harness.waitFor(screen => screen.some(l => l.includes('second')), 'the second line')
    await harness.settle()

    const { caret, cursor } = caretAndCursor(harness)
    expect(caret).toBeDefined()
    expect(cursor).toEqual(caret)
  }, 30_000)

  it('follows the caret back up to an earlier line', async () => {
    harness = await openComposer()
    harness.type('first')
    await harness.waitFor(screen => screen.some(l => l.includes('first')), 'the first line')
    harness.key('ctrl-j')
    harness.type('second')
    await harness.waitFor(screen => screen.some(l => l.includes('second')), 'the second line')
    harness.key('up')
    await harness.settle()

    const { caret, cursor } = caretAndCursor(harness)
    expect(caret).toBeDefined()
    expect(cursor).toEqual(caret)
  }, 30_000)

  // A line longer than the composer is cropped around the cursor, and the crop
  // draws an ellipsis ahead of the text. A cell counted for the text but not
  // for the ellipsis puts the composing character one cell to the left.
  it('accounts for the ellipsis when a long line is cropped', async () => {
    harness = await openComposer({ columns: 40 })
    harness.type('0123456789012345678901234567890123456789012345678901234567890123456789')
    await harness.waitFor(screen => screen.some(l => l.includes('…')), 'the crop')
    await harness.settle()

    const { caret, cursor } = caretAndCursor(harness)
    expect(caret).toBeDefined()
    expect(cursor).toEqual(caret)
  }, 30_000)

  // The case an input method actually produces, with more to come after it.
  it('follows the caret inserted between wide characters', async () => {
    harness = await openComposer()
    harness.type('你好世界')
    await harness.waitFor(screen => screen.some(l => l.includes('你好')), 'the text')

    harness.key('left')
    await harness.settle()

    const { caret, cursor } = caretAndCursor(harness)
    expect(caret).toBeDefined()
    expect(cursor).toEqual(caret)
  }, 30_000)
})
