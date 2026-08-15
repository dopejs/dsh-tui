import { runCli } from '../src/cli.js'

runCli([], { crashAfterRender: true }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-tui fixture: ${message}\n`)
  process.exitCode = 1
})
