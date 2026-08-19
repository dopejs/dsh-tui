import { afterEach, describe, expect, it } from 'vitest'

import { ScreenHarness } from '../../test-fixtures/screen-harness'

const onPosix = process.platform === 'win32' ? describe.skip : describe

let harness: ScreenHarness | undefined
afterEach(() => {
  harness?.dispose()
  harness = undefined
})

/**
 * Lines that carry two rows' worth of content.
 *
 * A redraw that starts on the wrong row overwrites what is there instead of
 * replacing it, and the result reads as corruption rather than as a bug. The
 * earlier check looked for a border glyph inside a line, which misses this
 * entirely: fused prose has no border in it.
 */
function fusedLines(screen: readonly string[], markers: readonly string[]): string[] {
  return screen.filter(line => markers.filter(marker => line.includes(marker)).length > 1)
}

onPosix('incremental redraw (M7.7)', () => {
  it('replaces rows rather than drawing over them, as the screen changes', async () => {
    harness = new ScreenHarness({ columns: 100, rows: 24, scenario: 'overflow' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('turn 59 of a long conversation')),
      'the conversation',
    )

    // Enough changes to make the renderer take its incremental paths: typing,
    // scrolling away from the tail, and scrolling back.
    for (const text of ['alpha', 'beta', 'gamma']) {
      harness.type(text)
      await harness.settle()
      for (let step = 0; step < text.length; step += 1) harness.key('left')
      await harness.settle()
    }
    harness.wheel('up')
    harness.wheel('up')
    await harness.settle()
    harness.wheel('down')
    await harness.settle()

    const screen = harness.screen()
    const markers = [
      'turn 5', 'turn 4', 'alphabetagamma', 'Try "explain', 'dsh-tui · session',
      'transcript ', 'Enter send',
    ]
    expect(fusedLines(screen, markers)).toEqual([])

    // And the status rows stay one fact each.
    const identity = screen.find(line => line.includes('dsh-tui · session')) ?? ''
    expect(identity).not.toContain('transcript ')
  }, 30_000)
})
