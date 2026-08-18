import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

import { filterMouseFromStdin } from './mouse-stdin'

const ESC = String.fromCodePoint(0x1b)

function fakeStdin(): NodeJS.ReadStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream
  Object.defineProperty(stream, 'isTTY', { value: true })
  Object.defineProperty(stream, 'setRawMode', { value: () => stream })
  return stream
}

describe('filterMouseFromStdin raw observation (M7.2)', () => {
  /*
   * The capability probe runs before the interface is mounted, so nothing is
   * reading the filtered stream yet. A transform only processes what is
   * written to it once its readable side is being consumed, so without this
   * the probe never saw the terminal's answer, concluded the protocol was
   * unsupported, and Shift-Enter silently stayed indistinguishable from Enter.
   */
  it('observes input while nothing is reading the filtered stream', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const seen: string[] = []
    filtered.onRaw(chunk => seen.push(chunk))

    source.write(`${ESC}[?1u`)
    await delay(20)

    expect(seen.join('')).toContain('[?1u')
    filtered.dispose()
  })

  // And nothing observed early may be lost: whatever was typed before the
  // interface existed still belongs to the user's first message.
  it('still delivers that input once the renderer starts reading', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    filtered.onRaw(() => undefined)

    source.write('hello')
    await delay(20)

    const delivered: string[] = []
    filtered.stream.on('data', chunk => delivered.push(String(chunk)))
    await delay(20)

    expect(delivered.join('')).toBe('hello')
    filtered.dispose()
  })
})
