import type { Instance } from 'ink'

export interface MountedInkRenderer {
  readonly exited: Promise<void>
  dispose(): Promise<void>
}

function outputFailure(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error('Terminal output stream failed', { cause: error })
}

export function mountOwnedInkRenderer(
  createRenderer: () => Pick<Instance, 'unmount' | 'waitUntilExit'>,
  stdout: NodeJS.WriteStream,
): MountedInkRenderer {
  let disposalRequested = false
  let failureReported = false
  let renderer: Pick<Instance, 'unmount' | 'waitUntilExit'> | undefined
  let pendingFailure: Error | undefined
  let rejectOutputFailure!: (error: Error) => void
  const outputFailureTask = new Promise<void>((_resolve, reject) => {
    rejectOutputFailure = reject
  })
  const fail = (error: unknown) => {
    if (disposalRequested || failureReported) return
    failureReported = true
    const failure = outputFailure(error)
    if (renderer === undefined) {
      pendingFailure ??= failure
      return
    }
    rejectOutputFailure(failure)
    renderer.unmount()
  }
  const onError = (error: unknown) => {
    fail(error)
  }
  const onClose = () => {
    fail(new Error('Terminal output stream closed unexpectedly'))
  }
  stdout.on('error', onError)
  stdout.on('close', onClose)
  const stopMonitoring = () => {
    stdout.off('error', onError)
    stdout.off('close', onClose)
  }
  try {
    renderer = createRenderer()
  } catch (error) {
    stopMonitoring()
    throw error
  }
  const ownedRenderer = renderer
  let exited: Promise<void>
  try {
    exited = Promise.race([
      ownedRenderer.waitUntilExit().then(() => undefined),
      outputFailureTask,
    ]).finally(stopMonitoring)
  } catch (error) {
    stopMonitoring()
    throw error
  }
  if (pendingFailure !== undefined) {
    rejectOutputFailure(pendingFailure)
    ownedRenderer.unmount()
  }
  // The owning runtime observes `exited`; this guard prevents a caller that
  // delays attaching its handler from creating a process-level rejection.
  void exited.catch(() => undefined)
  let disposing: Promise<void> | undefined
  return {
    exited,
    dispose() {
      disposing ??= (async () => {
        disposalRequested = true
        ownedRenderer.unmount()
        try {
          await exited
        } catch {
          // `exited` is the primary renderer/output failure channel. Disposal
          // only owns quiescence and must not report the same failure twice.
        }
      })()
      return disposing
    },
  }
}
