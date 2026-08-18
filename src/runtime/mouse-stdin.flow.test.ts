import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { filterMouseFromStdin } from './mouse-stdin'

/**
 * A stand-in for stdin that records flow control, which is the part the filter
 * has to forward rather than absorb.
 */
function fakeStdin(): NodeJS.ReadStream & { paused: number, resumed: number } {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
    paused: number
    resumed: number
  }
  stream.paused = 0
  stream.resumed = 0
  Object.defineProperty(stream, 'isTTY', { value: true })
  Object.defineProperty(stream, 'setRawMode', { value: () => stream })
  const pause = stream.pause.bind(stream)
  const resume = stream.resume.bind(stream)
  stream.pause = (() => {
    stream.paused += 1
    return pause()
  }) as typeof stream.pause
  stream.resume = (() => {
    stream.resumed += 1
    return resume()
  }) as typeof stream.resume
  return stream
}

describe('filterMouseFromStdin flow control (M7.1)', () => {
  // Ink believes it owns stdin, so when it pauses on unmount that has to reach
  // the real descriptor. Pausing only the filter leaves the real one flowing
  // with its handle open, which on Linux kept the process alive after the
  // interface was gone -- the interface exited, the process did not.
  it('forwards pause and resume to the real stdin', () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)

    filtered.stream.pause()
    expect(source.paused).toBeGreaterThan(0)

    filtered.stream.resume()
    expect(source.resumed).toBeGreaterThan(0)

    filtered.dispose()
  })

  // Disposal must not leave the source flowing either, for the same reason.
  it('leaves the real stdin paused once disposed', () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const before = source.paused

    filtered.dispose()

    expect(source.paused).toBeGreaterThan(before)
  })
})
