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
  /*
   * A command is typed in the composer, and the commands are offered above it
   * as it is typed -- the way a path is offered once one is being typed.
   *
   * This used to take over the keyboard with a palette carrying a query line
   * of its own, which put the text somewhere other than where the user was
   * looking and made an argument something to hand back afterwards.
   */
  it('offers the commands while a command is being typed', async () => {
    harness = await openComposer()
    harness.type('/')
    await harness.waitFor(
      screen => screen.some(line => line.includes('/model')),
      'the commands offered',
    )
    await harness.settle()

    // The text stayed in the composer, which is the whole point: it is a
    // message being typed, not a query in a panel of its own.
    const screen = harness.screen()
    // The composer still holds the text: it is a message being typed, not a
    // query living in a panel. Found by the box it is drawn in rather than by
    // the prompt glyph, which the selected completion row also uses.
    const composerTop = screen.findLastIndex(line => line.startsWith('\u256d'))
    expect((screen[composerTop + 1] ?? '')).toContain('/')
    // The count, not a particular row: the list is bounded by the space it
    // has, so which entries are visible is not something the feature promises.
    expect(screen.some(line => line.includes('1/3'))).toBe(true)
  }, 30_000)

  it('narrows the list as more of the command is typed', async () => {
    harness = await openComposer()
    harness.type('/')
    await harness.waitFor(
      screen => screen.some(line => line.includes('1/3')),
      'all three commands',
    )
    harness.type('mod')
    await harness.waitFor(
      screen => screen.some(line => line.includes('1/1')),
      'the list narrowed to one',
    )
    expect(harness.screen().some(line => line.includes('/model'))).toBe(true)
  }, 30_000)

  it('leaves a slash alone once there is something to send', async () => {
    harness = await openComposer()
    harness.type('read src/index.ts')
    await harness.waitFor(
      screen => screen.some(line => line.includes('read src/index.ts')),
      'the typed text',
    )
    await harness.settle()
    // A slash inside a path is a slash: the commands are not offered for it.
    expect(harness.screen().some(line => line.includes('Command completion'))).toBe(false)
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
