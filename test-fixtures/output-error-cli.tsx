import { runCli } from '../src/cli'

const running = runCli([])
setImmediate(() => {
  process.stdout.emit(
    'error',
    Object.assign(new Error('Injected terminal output failure'), { code: 'EPIPE' }),
  )
})

running.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-tui output fixture: ${message}\n`)
  process.exitCode = 1
})
