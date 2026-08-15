import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'

export const RUNTIME_PLUGIN_NAME = 'tui-runtime'

export type RuntimeDisposer = () => Promise<void> | void

export interface RuntimeFactory {
  (ctx: Context, signal: AbortSignal): Promise<RuntimeDisposer> | RuntimeDisposer
}

export interface RuntimeErrorReporter {
  (ctx: Context, error: unknown): Promise<void> | void
}

export interface RuntimePluginOptions {
  readonly reportError?: RuntimeErrorReporter
  readonly start: RuntimeFactory
}

function abortError(): Error {
  const error = new Error('TUI runtime startup was aborted')
  error.name = 'AbortError'
  return error
}

function waitWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      settle(() => {
        reject(abortError())
      })
    }
    const settle = (complete: () => void) => {
      signal.removeEventListener('abort', onAbort)
      complete()
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      () => {
        settle(resolve)
      },
      (error: unknown) => {
        settle(() => {
          reject(error)
        })
      },
    )
  })
}

async function awaitLoaderSettlement(ctx: Context, signal: AbortSignal): Promise<void> {
  const loader = ctx.get('loader')
  if (loader === undefined) return
  await waitWithAbort(loader.await(), signal)
}

function isExpectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && error.name === 'AbortError'
}

function defaultErrorReporter(ctx: Context, error: unknown): void {
  ctx.logger(RUNTIME_PLUGIN_NAME).error(error)
}

async function reportSafely(
  ctx: Context,
  error: unknown,
  reporter: RuntimeErrorReporter,
): Promise<void> {
  try {
    await reporter(ctx, error)
  } catch (reportingError) {
    try {
      ctx.logger(RUNTIME_PLUGIN_NAME).error(
        new AggregateError(
          [error, reportingError],
          'TUI runtime startup and error reporting both failed',
        ),
      )
    } catch {
      // Cordis owns the logger. A broken reporter and logger leave no safe
      // in-process reporting path, but must not create an unhandled rejection.
    }
  }
}

export function createRuntimePlugin(options: RuntimePluginOptions): Plugin.Object<void> {
  const reporter = options.reportError ?? defaultErrorReporter

  return {
    name: RUNTIME_PLUGIN_NAME,
    apply(ctx) {
      const abortController = new AbortController()
      let disposeRuntime: RuntimeDisposer | undefined
      let runtimeDisposed = false

      const disposeStartedRuntime = async () => {
        if (runtimeDisposed || disposeRuntime === undefined) return
        runtimeDisposed = true
        await disposeRuntime()
      }

      const startup = (async () => {
        try {
          await awaitLoaderSettlement(ctx, abortController.signal)
          if (abortController.signal.aborted) return

          const startedRuntime = await options.start(ctx, abortController.signal)
          if (abortController.signal.aborted) {
            disposeRuntime = startedRuntime
            await disposeStartedRuntime()
            return
          }
          disposeRuntime = startedRuntime
        } catch (error) {
          if (isExpectedAbort(error, abortController.signal)) return
          await reportSafely(ctx, error, reporter)
        }
      })()

      return async () => {
        abortController.abort()
        await startup
        await disposeStartedRuntime()
      }
    },
  }
}
