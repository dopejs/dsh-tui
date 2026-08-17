import { describe, expect, it, vi } from 'vitest'

import { requestExitUntilHonoured } from './exit-request'

/** Drives the retry loop deterministically instead of on a real timer. */
function fakeRepeat() {
  let pending: (() => void) | undefined
  let stopped = false
  return {
    repeat: (callback: () => void) => {
      pending = callback
      return {
        stop: () => {
          stopped = true
          pending = undefined
        },
      }
    },
    get stopped() {
      return stopped
    },
    tick(times = 1) {
      for (let index = 0; index < times; index += 1) pending?.()
    },
  }
}

describe('requestExitUntilHonoured (M5.1/M5.2)', () => {
  // The regression: a single appExit issued from the plugin's start is dropped
  // before the launcher's shutdown controller exists, leaving --doctor and
  // --print alive forever with their output already written.
  it('never requests the exit synchronously', () => {
    const exit = vi.fn()
    const scheduler = fakeRepeat()
    requestExitUntilHonoured(exit, 0, { repeat: scheduler.repeat })
    expect(exit).not.toHaveBeenCalled()
  })

  it('keeps requesting until the launcher acts on it', () => {
    const exit = vi.fn()
    const scheduler = fakeRepeat()
    requestExitUntilHonoured(exit, 2, { repeat: scheduler.repeat })

    scheduler.tick(3)
    expect(exit).toHaveBeenCalledTimes(3)
    expect(exit).toHaveBeenLastCalledWith(2)
  })

  it('stops retrying when the caller disposes', () => {
    const exit = vi.fn()
    const scheduler = fakeRepeat()
    const stop = requestExitUntilHonoured(exit, 0, { repeat: scheduler.repeat })

    scheduler.tick()
    stop()
    scheduler.tick(5)

    expect(exit).toHaveBeenCalledOnce()
    expect(scheduler.stopped).toBe(true)
  })

  // A request that is never honoured must not spin for the process's lifetime.
  it('gives up after a bounded number of attempts', () => {
    const exit = vi.fn()
    const scheduler = fakeRepeat()
    requestExitUntilHonoured(exit, 1, { repeat: scheduler.repeat })

    scheduler.tick(400)

    expect(exit.mock.calls.length).toBeLessThanOrEqual(300)
    expect(scheduler.stopped).toBe(true)
  })

  it('is a no-op without a launcher exit seam', () => {
    const scheduler = fakeRepeat()
    expect(() => {
      const stop = requestExitUntilHonoured(undefined, 1, { repeat: scheduler.repeat })
      scheduler.tick(3)
      stop()
    }).not.toThrow()
  })

  it('carries the exit code the run earned', () => {
    for (const code of [0, 1, 2, 130]) {
      const exit = vi.fn()
      const scheduler = fakeRepeat()
      requestExitUntilHonoured(exit, code, { repeat: scheduler.repeat })
      scheduler.tick()
      expect(exit).toHaveBeenCalledExactlyOnceWith(code)
    }
  })

  // The retry must never be the reason the process is still alive.
  it('unrefs its real timer', () => {
    const exit = vi.fn()
    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      { unref } as unknown as ReturnType<typeof setInterval>,
    )
    try {
      requestExitUntilHonoured(exit, 0)
      expect(unref).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})
