import { spawnSync } from 'node:child_process'

const entry = process.argv[2]
if (entry === undefined) {
  throw new Error('PTY wrapper requires an entry module')
}

function readTerminalState() {
  const result = spawnSync('stty', ['-g'], {
    encoding: 'utf8',
    stdio: [0, 'pipe', 2],
  })
  if (result.status !== 0) {
    throw new Error(`stty exited with status ${result.status ?? 'unknown'}`)
  }
  return result.stdout.trim()
}

const before = readTerminalState()
const child = spawnSync(process.execPath, ['--import', 'tsx', entry], {
  stdio: 'inherit',
})
const after = readTerminalState()

process.stdout.write(`__STTY_BEFORE__${before}\n`)
process.stdout.write(`__STTY_AFTER__${after}\n`)
process.exitCode = child.status ?? 1
