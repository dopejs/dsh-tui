import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const launcher = join(root, 'bin', 'dsh-tui.js')

/**
 * The launcher is a standalone script with no exports, so its behaviour is
 * exercised the way a user gets it: as a process.
 */
function runLauncher(env: Record<string, string>): { status: number, output: string } {
  try {
    const output = execFileSync(process.execPath, [launcher, '--doctor'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    return { output, status: 0 }
  } catch (error) {
    const failure = error as { status?: number, stderr?: string, stdout?: string }
    return {
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      status: failure.status ?? -1,
    }
  }
}

describe('dtui launcher (M6)', () => {
  // Refusing here is not caution: dsh applies this launcher's bundle patch to
  // the profile's older package, so starting fails on module resolution with a
  // far less obvious error than this message.
  it('refuses to start when the profile package is older than the launcher', () => {
    const result = runLauncher({ DSH_HOME: join(root, 'test-fixtures', 'launcher', 'older') })
    expect(result.status).toBe(1)
    expect(result.output).toContain('Starting would apply this launcher')
    expect(result.output).toContain('dsh plugin --profile tui add')
  })

  // The newer package brings its own composition, so the launcher defers to it.
  it('warns but continues when the profile package is newer', () => {
    const result = runLauncher({ DSH_HOME: join(root, 'test-fixtures', 'launcher', 'newer') })
    expect(result.output).toContain('Starting the profile version')
    expect(result.output).not.toContain('Starting would apply')
  })
})
