import { pathToFileURL } from 'node:url'
import { render } from 'ink'

import { ResourceOwner } from './runtime/resource-owner'
import { formatHelp, parseStartupArguments } from './startup'
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

  try {
    const renderer = render(
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
    )
    owner.own('Ink renderer and terminal state', async () => {
      renderer.unmount()
      await renderer.waitUntilExit()
    })
    void renderer.waitUntilExit().then(requestShutdown, (error: unknown) => {
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
  } finally {
    await owner.dispose()
  }

  if (rendererFailure !== undefined) {
    throw rendererFailure
  }
}

const executable = process.argv[1]
if (executable !== undefined && import.meta.url === pathToFileURL(executable).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-tui: ${message}\n`)
    process.exitCode = 1
  })
}
