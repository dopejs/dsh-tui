import { resolve } from 'node:path'
import { spawn, type IPty } from '@lydell/node-pty'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const cli = resolve(root, 'src/cli.tsx')
const crashingCli = resolve(root, 'test-fixtures/crashing-cli.tsx')
const outputErrorCli = resolve(root, 'test-fixtures/output-error-cli.tsx')
const ptyWrapper = resolve(root, 'test-fixtures/pty-wrapper.mjs')
const terminalKitCli = resolve(root, 'test-fixtures/terminal-kit-cli.ts')

interface PtyResult {
  readonly exitCode: number
  readonly output: string
}

const itWithPosixSignals = process.platform === 'win32' ? it.skip : it

function startCli(
  entry = cli,
  measureTerminalState = false,
  entryArguments: readonly string[] = [],
): { process: IPty; result: Promise<PtyResult> } {
  const args = measureTerminalState
    ? [ptyWrapper, entry]
    : ['--import', 'tsx', entry, ...entryArguments]
  const child = spawn(process.execPath, args, {
    cols: 80,
    cwd: root,
    env: {
      ...process.env,
      CI: '',
      FORCE_COLOR: '0',
      TERM: 'xterm-256color',
    },
    name: 'xterm-256color',
    rows: 24,
  })
  let output = ''
  child.onData((data) => {
    output += data
  })
  const result = new Promise<PtyResult>((resolveResult) => {
    child.onExit(({ exitCode }) => {
      resolveResult({ exitCode, output })
    })
  })
  return { process: child, result }
}

async function waitForScreen(child: IPty, output: () => string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!output().includes('Standalone terminal lifecycle fixture')) {
    if (Date.now() >= deadline) {
      child.kill()
      throw new Error(`TUI did not render before timeout. Output: ${output()}`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
}

async function exerciseExit(action: (child: IPty) => void): Promise<PtyResult> {
  const running = startCli()
  let captured = ''
  running.process.onData((data) => {
    captured += data
  })
  await waitForScreen(running.process, () => captured)
  action(running.process)
  return running.result
}

/*
 * These spawn a process and drive it through a pseudo-terminal, so the default
 * timeout -- tuned for tests that call a function -- is the wrong measure.
 * Windows ran into it while asserting nothing about speed.
 */
describe('CLI terminal lifecycle', () => {
  it('restores the alternate screen after normal quit', async () => {
    const running = startCli(cli, process.platform !== 'win32')
    let captured = ''
    running.process.onData((data) => {
      captured += data
    })
    await waitForScreen(running.process, () => captured)
    running.process.write('q')
    const result = await running.result

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('\u001B[?1049h')
    expect(result.output).toContain('\u001B[?1049l')
    if (process.platform !== 'win32') {
      const before = /__STTY_BEFORE__(.+)/.exec(result.output)?.[1]?.trim()
      const after = /__STTY_AFTER__(.+)/.exec(result.output)?.[1]?.trim()
      expect(before).toBeTruthy()
      expect(after).toBe(before)
    }
  }, 30_000)

  it('restores the alternate screen after Ctrl-C input', async () => {
    const result = await exerciseExit((child) => {
      child.write('\u0003')
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('\u001B[?1049l')
  }, 30_000)

  itWithPosixSignals.each(['SIGINT', 'SIGTERM'] as const)(
    'restores the alternate screen after %s',
    async (signal) => {
      const result = await exerciseExit((child) => {
        child.kill(signal)
      })

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('\u001B[?1049l')
    },
  )

  it('M2.4-F06 restores the alternate screen after a post-render failure', async () => {
    const running = startCli(crashingCli)
    const result = await running.result

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('\u001B[?1049h')
    expect(result.output).toContain('\u001B[?1049l')
    expect(result.output).toContain('Injected post-render failure')
  }, 30_000)

  it('M2.4-F07 contains an output error and restores the alternate screen', async () => {
    const running = startCli(outputErrorCli)
    const result = await running.result

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('\u001B[?1049h')
    expect(result.output).toContain('\u001B[?1049l')
    expect(result.output).toContain('Injected terminal output failure')
  }, 30_000)
})

describe('Terminal Kit candidate lifecycle', () => {
  it('restores raw mode and the alternate screen after normal quit', async () => {
    const running = startCli(terminalKitCli, process.platform !== 'win32')
    let captured = ''
    running.process.onData((data) => {
      captured += data
    })
    await waitForScreen(running.process, () => captured)
    running.process.write('q')
    const result = await running.result

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('\u001B[?1049h')
    expect(result.output).toContain('\u001B[?1049l')
    if (process.platform !== 'win32') {
      const before = /__STTY_BEFORE__(.+)/.exec(result.output)?.[1]?.trim()
      const after = /__STTY_AFTER__(.+)/.exec(result.output)?.[1]?.trim()
      expect(after).toBe(before)
    }
  }, 30_000)

  itWithPosixSignals.each(['SIGINT', 'SIGTERM'] as const)(
    'restores the alternate screen after %s',
    async (signal) => {
      const running = startCli(terminalKitCli)
      let captured = ''
      running.process.onData((data) => {
        captured += data
      })
      await waitForScreen(running.process, () => captured)
      running.process.kill(signal)
      const result = await running.result

      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('\u001B[?1049l')
    },
  )

  it('restores the alternate screen after a post-acquisition failure', async () => {
    const running = startCli(terminalKitCli, false, ['--crash'])
    const result = await running.result

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('\u001B[?1049h')
    expect(result.output).toContain('\u001B[?1049l')
    expect(result.output).toContain('Injected post-acquisition failure')
  }, 30_000)
})
