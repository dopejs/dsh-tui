import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'

import { createRuntimePlugin } from './cordis-runtime'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let reject!: Deferred<T>['reject']
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

describe('Cordis TUI runtime plugin', () => {
  it('waits for loader settlement before starting and owns runtime disposal', async () => {
    const ctx = new Context()
    const settlement = deferred<undefined>()
    ctx.provide('loader', { await: () => settlement.promise } as never)
    const disposeRuntime = vi.fn()
    const start = vi.fn(() => disposeRuntime)
    const fiber = ctx.plugin(createRuntimePlugin({ start }))

    await fiber
    expect(start).not.toHaveBeenCalled()

    settlement.resolve(undefined)
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce()
    })

    await Promise.all([fiber.dispose(), fiber.dispose()])
    expect(disposeRuntime).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('settles disposal while loader settlement is still pending', async () => {
    const ctx = new Context()
    const settlement = deferred<undefined>()
    ctx.provide('loader', { await: () => settlement.promise } as never)
    const start = vi.fn(() => vi.fn())
    const fiber = ctx.plugin(createRuntimePlugin({ start }))

    await fiber
    await fiber.dispose()
    expect(start).not.toHaveBeenCalled()

    settlement.resolve(undefined)
    await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('aborts startup and disposes a runtime that resolves after unload begins', async () => {
    const ctx = new Context()
    const startedRuntime = deferred<() => void>()
    const disposeRuntime = vi.fn()
    let startupSignal: AbortSignal | undefined
    const start = vi.fn((_ctx: Context, signal: AbortSignal) => {
      startupSignal = signal
      return startedRuntime.promise
    })
    const fiber = ctx.plugin(createRuntimePlugin({ start }))

    await fiber
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce()
    })
    const disposal = fiber.dispose()
    await vi.waitFor(() => {
      expect(startupSignal?.aborted).toBe(true)
    })

    startedRuntime.resolve(disposeRuntime)
    await disposal
    expect(disposeRuntime).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('awaits asynchronous runtime disposal to quiescence', async () => {
    const ctx = new Context()
    const disposed = deferred<undefined>()
    const disposeRuntime = vi.fn(() => disposed.promise)
    const fiber = ctx.plugin(createRuntimePlugin({ start: () => disposeRuntime }))

    await fiber
    await vi.waitFor(() => {
      expect(disposeRuntime).not.toHaveBeenCalled()
    })
    const disposal = fiber.dispose()
    await vi.waitFor(() => {
      expect(disposeRuntime).toHaveBeenCalledOnce()
    })

    let settled = false
    void disposal.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    disposed.resolve(undefined)
    await disposal
    expect(settled).toBe(true)
    await ctx.fiber.dispose()
  })

  it('reports loader and runtime startup failures without leaking tasks', async () => {
    const loaderContext = new Context()
    const loaderFailure = new Error('loader failed')
    loaderContext.provide('loader', {
      await: () => Promise.reject(loaderFailure),
    } as never)
    const reportLoaderError = vi.fn()
    const loaderStart = vi.fn(() => vi.fn())
    const loaderFiber = loaderContext.plugin(
      createRuntimePlugin({ reportError: reportLoaderError, start: loaderStart }),
    )

    await loaderFiber
    await vi.waitFor(() => {
      expect(reportLoaderError).toHaveBeenCalledWith(loaderFiber.ctx, loaderFailure)
    })
    expect(loaderStart).not.toHaveBeenCalled()
    await loaderFiber.dispose()
    await loaderContext.fiber.dispose()

    const runtimeContext = new Context()
    const runtimeFailure = new Error('runtime failed')
    const reportRuntimeError = vi.fn()
    const runtimeFiber = runtimeContext.plugin(
      createRuntimePlugin({
        reportError: reportRuntimeError,
        start: () => Promise.reject(runtimeFailure),
      }),
    )

    await runtimeFiber
    await vi.waitFor(() => {
      expect(reportRuntimeError).toHaveBeenCalledWith(runtimeFiber.ctx, runtimeFailure)
    })
    await runtimeFiber.dispose()
    await runtimeContext.fiber.dispose()
  })
})
