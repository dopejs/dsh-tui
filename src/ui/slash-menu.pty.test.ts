import { afterEach, describe, expect, it } from 'vitest'

import { ScreenHarness } from '../../test-fixtures/screen-harness'

const onPosix = process.platform === 'win32' ? describe.skip : describe

let harness: ScreenHarness | undefined
afterEach(() => {
  harness?.dispose()
  harness = undefined
})

async function openComposer(): Promise<ScreenHarness> {
  const created = new ScreenHarness({ columns: 70, rows: 32, scenario: 'empty' })
  await created.waitFor(
    screen => screen.some(line => line.includes('/ for commands')),
    'the composer hint',
  )
  return created
}

onPosix('the slash menu (M7.5)', () => {
  // Every action lived behind Ctrl-P, which is not a chord anyone guesses.
  it('opens the command menu when a message starts with a slash', async () => {
    harness = await openComposer()
    harness.type('/')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Command palette')),
      'the command menu',
    )
    expect(harness.screen().join('\n')).toContain('Exit TUI')
  }, 30_000)

  // A slash inside a sentence or a path is a slash.
  it('leaves a slash alone once there is something to send', async () => {
    harness = await openComposer()
    harness.type('read src/index.ts')
    await harness.waitFor(
      screen => screen.some(line => line.includes('read src/index.ts')),
      'the typed text',
    )
    await harness.settle()
    expect(harness.screen().join('\n')).not.toContain('Command palette')
  }, 30_000)

  /*
   * Slash commands take arguments, and a menu that swallowed the keystrokes
   * would make `/model ark/deepseek-v4` unreachable. Escape hands back what was
   * typed, so it can be finished and sent like anything else.
   */
  /*
   * Tab takes a command without running it, with a trailing space, because
   * what follows is an argument and every one of them is separated from the
   * name by exactly that. Tab used to be a second way to move down, which the
   * arrows already do.
   */
  it('hands the selected command to the composer on Tab, ready for an argument', async () => {
    harness = await openComposer()
    harness.type('/')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Command palette')),
      'the command menu',
    )
    harness.type('model')
    await harness.waitFor(
      screen => screen.some(line => line.includes('\u203a /model')),
      'the model command to be selected',
    )
    await harness.settle()
    harness.key('tab')
    // Waited on the menu closing, not on the text: the menu lists `/model` too,
    // so looking for the text alone matches the row that is still on screen.
    await harness.waitFor(
      screen => !screen.some(line => line.includes('Command palette')),
      'the menu to close',
    )
    await harness.settle()

    expect(harness.screen().some(line => line.includes('/model '))).toBe(true)
    // The caret sits after the space, where the argument goes.
    const caret = harness.invertedCells()[0]
    const row = harness.screen()[caret?.row ?? 0] ?? ''
    expect(caret?.column).toBe(row.indexOf('/model ') + '/model '.length)
  }, 30_000)

  /*
   * A terminal delivers text on paste and nothing else, so an image has to be
   * asked for. Every outcome is reported: a key that sometimes silently does
   * nothing is a key nobody trusts, and "the clipboard is empty" is not the
   * same as "this system cannot be asked".
   */
  it('says so when the clipboard holds no image', async () => {
    harness = await openComposer()
    harness.type('\u0016')
    await harness.waitFor(
      screen => screen.some(line => line.includes('No image on the clipboard')),
      'the empty-clipboard notice',
    )
  }, 30_000)

  /*
   * `/model` with nothing to act on opens a list to choose from.
   *
   * It used to print the routes into the transcript, which left the exact
   * string to be copied back out by hand -- a list you cannot act on is a
   * worse answer than the usage text it replaced.
   */
  it('offers the models as a list to move through and choose', async () => {
    harness = new ScreenHarness({ columns: 70, rows: 32, scenario: 'models' })
    await harness.waitFor(
      screen => screen.some(line => line.includes('Select model')),
      'the model picker',
    )
    await harness.settle()

    const screen = harness.screen()
    expect(screen.join('\n')).toContain('ark/deepseek-v4-pro')
    expect(screen.join('\n')).toContain('deepseek-official/deepseek-v4-flash')
    // The first is selected, and the footer says where in the list it is.
    expect(screen.some(line => line.includes('\u203a 1. ark/deepseek-v4-pro'))).toBe(true)
    expect(screen.join('\n')).toContain('1/3')

    harness.key('down')
    await harness.waitFor(
      screen2 => screen2.some(line => line.includes('\u203a 2. ')),
      'the selection to move',
    )
    expect(harness.screen().join('\n')).toContain('2/3')
  }, 30_000)

  /*
   * Escape used to end the session from an empty composer, which is a long way
   * from what the key means anywhere else and one stray press from losing the
   * terminal. `/exit` and Ctrl-C still quit.
   */
  it('does not quit when Escape is pressed with nothing to cancel', async () => {
    harness = await openComposer()
    harness.key('escape')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Nothing to cancel')),
      'the notice',
    )
    await harness.settle()

    // Still running, and still showing the composer.
    expect(harness.screen().some(line => line.includes('Try "explain'))).toBe(true)
  }, 30_000)

  // A draft is cleared by Escape, but only when there is no more urgent thing
  // for it to do.
  it('clears a draft on Escape while the agent is idle', async () => {
    harness = await openComposer()
    harness.type('some draft')
    await harness.waitFor(
      screen => screen.some(line => line.includes('some draft')),
      'the draft',
    )
    harness.key('escape')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Composer cleared')),
      'the cleared notice',
    )
    expect(harness.screen().some(line => line.includes('some draft'))).toBe(false)
  }, 30_000)
})
