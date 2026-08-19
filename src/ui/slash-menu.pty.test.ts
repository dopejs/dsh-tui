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
    screen => screen.some(line => line.includes('command palette')),
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
  it('hands the typed command back to the composer on Escape', async () => {
    harness = await openComposer()
    harness.type('/')
    await harness.waitFor(
      screen => screen.some(line => line.includes('Command palette')),
      'the command menu',
    )
    harness.type('model ark/deepseek-v4')
    await harness.settle()
    harness.key('escape')
    await harness.waitFor(
      screen => screen.some(line => line.includes('/model ark/deepseek-v4')),
      'the command back in the composer',
    )
    expect(harness.screen().join('\n')).not.toContain('Command palette')
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
})
