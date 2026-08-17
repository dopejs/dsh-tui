/**
 * Exit requests for one-shot runtimes (`--doctor`, `--print`).
 *
 * The launcher's `appExit` is only honoured once its shutdown controller is
 * installed, which happens some time after the runtime plugin's `start` has
 * run. A request made before then is dropped: the launcher's
 * `await runProfile(...)` never settles and the process stays alive with its
 * output already written — which is what shipped, because the pure runners were
 * unit tested while the wiring to `appExit` was not.
 *
 * The interactive runtime never hits this: it exits only from a later user
 * event, long after boot.
 *
 * No public seam reports that readiness. `loader.await()` is not it — it does
 * not settle while the runtime is live. So the request is repeated until the
 * launcher acts on it, on an `unref`ed timer that can never itself keep the
 * process alive.
 */

export type ExitRequester = (code: number) => void

/** How often to re-request, and the bound after which we stop trying. */
const RETRY_INTERVAL_MS = 100
const GIVE_UP_AFTER_MS = 30_000

export interface ExitRequestSchedulers {
  /** Injection seam for tests; defaults to an `unref`ed interval. */
  readonly repeat?: (callback: () => void, everyMs: number) => { stop: () => void }
}

function defaultRepeat(callback: () => void, everyMs: number): { stop: () => void } {
  const timer = setInterval(callback, everyMs)
  // Never let the retry itself be the reason the process is still running.
  timer.unref?.()
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}

/**
 * Ask the launcher to exit, and keep asking until it does.
 *
 * @param exit - the launcher's exit seam; absent means nothing can be requested.
 * @param code - the process exit code the run earned.
 * @param schedulers - injection seam for tests.
 * @returns a disposer that stops the retries.
 */
export function requestExitUntilHonoured(
  exit: ExitRequester | undefined,
  code: number,
  schedulers: ExitRequestSchedulers = {},
): () => void {
  if (exit === undefined) return () => undefined
  const repeat = schedulers.repeat ?? defaultRepeat
  let elapsed = 0
  const handle = repeat(() => {
    elapsed += RETRY_INTERVAL_MS
    if (elapsed > GIVE_UP_AFTER_MS) {
      handle.stop()
      return
    }
    exit(code)
  }, RETRY_INTERVAL_MS)
  return handle.stop
}
