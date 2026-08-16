import { pathToFileURL } from 'node:url'
import { render } from 'ink'

import { ResourceOwner } from './runtime/resource-owner'
import { formatHelp, parseStartupArguments } from './startup'
import { mountOwnedInkRenderer } from './ui/ink-lifecycle'
import { Shell } from './ui/shell'

const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM'] as const

export interface CliRuntimeOptions {
  readonly crashAfterRender?: boolean
}

export async function runCli(
  argv: readonly string[],
  runtimeOptions: CliRuntimeOptions = {},
): Promise<void> {
  const startup = parseStartupArguments(argv)
  if (startup.help) {
    process.stdout.write(`${formatHelp()}\n`)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('dsh-tui requires interactive TTY stdin and stdout')
  }

  const owner = new ResourceOwner()
  let rendererFailure: unknown
  let resolveShutdown: (() => void) | undefined
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve
  })
  const requestShutdown = () => {
    resolveShutdown?.()
    resolveShutdown = undefined
  }

  let primaryFailure: unknown
  try {
    const mountedRenderer = mountOwnedInkRenderer(
      () => render(
        <Shell
          onQuit={requestShutdown}
          {...(runtimeOptions.crashAfterRender === undefined
            ? {}
            : { crashAfterRender: runtimeOptions.crashAfterRender })}
          {...(startup.resumeSessionId === undefined
            ? {}
            : { resumeSessionId: startup.resumeSessionId })}
        />,
        {
          alternateScreen: true,
          exitOnCtrlC: false,
          incrementalRendering: true,
          interactive: true,
          maxFps: 20,
        },
      ),
      process.stdout,
    )
    owner.own('Ink renderer and terminal state', () => mountedRenderer.dispose())
    void mountedRenderer.exited.then(requestShutdown, (error: unknown) => {
      rendererFailure = error
      requestShutdown()
    })

    const signalListeners = new Map<NodeJS.Signals, () => void>()
    const stopListeningForSignals = () => {
      for (const [signal, listener] of signalListeners) {
        process.off(signal, listener)
      }
      signalListeners.clear()
    }
    for (const signal of TERMINATION_SIGNALS) {
      const listener = () => {
        stopListeningForSignals()
        requestShutdown()
      }
      signalListeners.set(signal, listener)
      process.on(signal, listener)
    }
    owner.own('termination signal listeners', stopListeningForSignals)

    await shutdown
    if (rendererFailure !== undefined) throw rendererFailure
  } catch (error) {
    primaryFailure = error
  }

  let cleanupFailure: unknown
  try {
    await owner.dispose()
  } catch (error) {
    cleanupFailure = error
  }

  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      'TUI failed and cleanup did not complete cleanly',
    )
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailure !== undefined) throw cleanupFailure
}

const executable = process.argv[1]
if (executable !== undefined && import.meta.url === pathToFileURL(executable).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-tui: ${message}\n`)
    process.exitCode = 1
  })
}
