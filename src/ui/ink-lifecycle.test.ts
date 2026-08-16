import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { mountOwnedInkRenderer } from './ink-lifecycle'

function rendererFixture() {
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const unmount = vi.fn(() => {
    resolveExit()
  })
  return {
    renderer: { unmount, waitUntilExit: () => exited },
    unmount,
  }
}

describe('owned Ink renderer failure recovery (M2.4)', () => {
  it('M2.4-F07 turns an output error into the primary exit failure and still disposes cleanly', async () => {
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const fixture = rendererFixture()
    const mounted = mountOwnedInkRenderer(() => fixture.renderer, output)
    const failure = Object.assign(new Error('terminal output closed'), { code: 'EPIPE' })

    expect(output.emit('error', failure)).toBe(true)
    output.emit('close')
    await expect(mounted.exited).rejects.toBe(failure)
    await expect(mounted.dispose()).resolves.toBeUndefined()
    await expect(mounted.dispose()).resolves.toBeUndefined()
    expect(fixture.unmount).toHaveBeenCalledWith()
    expect(fixture.unmount).toHaveBeenCalledTimes(2)
    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount('close')).toBe(0)
  })

  it('M2.4-F07 treats an unexpected output close as a fatal renderer boundary', async () => {
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const fixture = rendererFixture()
    const mounted = mountOwnedInkRenderer(() => fixture.renderer, output)

    output.emit('close')
    await expect(mounted.exited).rejects.toThrow('output stream closed unexpectedly')
    await mounted.dispose()
    expect(fixture.unmount).toHaveBeenCalledWith()
  })

  it('removes output listeners when renderer construction fails', () => {
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const failure = new Error('renderer construction failed')

    expect(() => mountOwnedInkRenderer(() => { throw failure }, output)).toThrow(failure)
    expect(output.listenerCount('error')).toBe(0)
    expect(output.listenerCount('close')).toBe(0)
  })

  it('captures an output failure emitted during renderer construction', async () => {
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const fixture = rendererFixture()
    const failure = new Error('early output failure')
    const mounted = mountOwnedInkRenderer(() => {
      output.emit('error', failure)
      return fixture.renderer
    }, output)

    await expect(mounted.exited).rejects.toBe(failure)
    expect(fixture.unmount).toHaveBeenCalledOnce()
    expect(fixture.unmount).toHaveBeenCalledWith()
    await mounted.dispose()
  })
})
