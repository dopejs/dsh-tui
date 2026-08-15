import terminalKit from 'terminal-kit'

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Terminal Kit fixture requires a TTY')
}

const term = terminalKit.terminal
let resolveShutdown: (() => void) | undefined
const shutdown = new Promise<void>((resolve) => {
  resolveShutdown = resolve
})
const requestShutdown = () => {
  resolveShutdown?.()
  resolveShutdown = undefined
}
const onKey = (name: string) => {
  if (name === 'q' || name === 'CTRL_C') {
    requestShutdown()
  }
}
const signals = ['SIGINT', 'SIGTERM'] as const

async function run(): Promise<void> {
  term.fullscreen(true)
  term.hideCursor()
  term.grabInput({})
  term.on('key', onKey)
  for (const signal of signals) {
    process.on(signal, requestShutdown)
  }

  try {
    term.moveTo(1, 1)
    term.bold('dsh-tui\n')
    term('Milestone 1 lifecycle shell\n')
    term.dim('Terminal Kit candidate\n')
    term.dim('Press q or Ctrl-C to exit.')
    if (process.argv.includes('--crash')) {
      throw new Error('Injected post-acquisition failure')
    }
    await shutdown
  } finally {
    for (const signal of signals) {
      process.off(signal, requestShutdown)
    }
    term.off('key', onKey)
    await Promise.resolve(term.grabInput(false, true))
    term.hideCursor(false)
    term.fullscreen(false)
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Terminal Kit fixture: ${message}\n`)
  process.exitCode = 1
})
