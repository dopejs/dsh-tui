import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { filterMouseFromStdin } from './mouse-stdin'
import type { MouseEvent } from './mouse'

// Built from the code point, never written as a bare character: an
// escape lost in an edit leaves the fixture and the expectation equally
// wrong, and the comparison green.
const ESC = String.fromCodePoint(0x1b)

function report(button: number, column: number, row: number, final: 'M' | 'm' = 'M'): string {
  return `${ESC}[<${String(button)};${String(column)};${String(row)}${final}`
}

/** A stand-in for stdin: a real stream, claiming to be a TTY. */
function fakeStdin(): NodeJS.ReadStream & { rawMode?: boolean } {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & { rawMode?: boolean }
  Object.defineProperty(stream, 'isTTY', { value: true })
  Object.defineProperty(stream, 'setRawMode', {
    value: (mode: boolean) => {
      stream.rawMode = mode
      return stream
    },
  })
  return stream
}

async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('filterMouseFromStdin (M7.1)', () => {
  // Without this, clicking puts `[<0;12;5M` in the composer.
  it('keeps mouse reports out of the stream handed to the renderer', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const seen: MouseEvent[] = []
    const text: string[] = []
    filtered.onMouse(event => seen.push(event))
    filtered.stream.on('data', chunk => text.push(String(chunk)))

    source.write(`ab${report(0, 12, 5)}cd`)
    await settle()

    expect(text.join('')).toBe('abcd')
    expect(seen).toEqual([{ column: 11, kind: 'press', row: 4 }])
    filtered.dispose()
  })

  // A terminal is under no obligation to deliver a report in one read.
  it('reassembles a report split across two reads', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const seen: MouseEvent[] = []
    const text: string[] = []
    filtered.onMouse(event => seen.push(event))
    filtered.stream.on('data', chunk => text.push(String(chunk)))

    source.write(`${ESC}[<65;3`)
    await settle()
    source.write(';7M')
    await settle()

    expect(seen).toEqual([{ column: 2, kind: 'wheel-down', row: 6 }])
    expect(text.join('')).toBe('')
    filtered.dispose()
  })

  // A fragment that never completes is not a report, and holding it forever
  // would swallow whatever the user typed after it.
  it('gives up on a fragment that never becomes a report', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const text: string[] = []
    filtered.stream.on('data', chunk => text.push(String(chunk)))

    source.write(`${ESC}[<${'9'.repeat(40)}`)
    await settle()

    expect(text.join('')).toContain('9')
    filtered.dispose()
  })

  it('passes ordinary typing straight through', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const text: string[] = []
    filtered.stream.on('data', chunk => text.push(String(chunk)))

    source.write('hello')
    await settle()

    expect(text.join('')).toBe('hello')
    filtered.dispose()
  })

  // Raw mode, TTY identity and reference counting belong to the real
  // descriptor; a proxy that answered for them itself would leave the terminal
  // in cooked mode and every keystroke line-buffered.
  it('delegates terminal control to the real stdin', () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)

    expect(filtered.stream.isTTY).toBe(true)
    filtered.stream.setRawMode(true)
    expect(source.rawMode).toBe(true)
    filtered.stream.setRawMode(false)
    expect(source.rawMode).toBe(false)
    filtered.dispose()
  })

  it('stops listening once disposed', async () => {
    const source = fakeStdin()
    const filtered = filterMouseFromStdin(source)
    const seen: MouseEvent[] = []
    filtered.onMouse(event => seen.push(event))

    filtered.dispose()
    source.write(report(0, 1, 1))
    await settle()

    expect(seen).toEqual([])
  })
})
