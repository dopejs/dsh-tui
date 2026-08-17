import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const launcher = join(root, 'bin', 'dsh-tui.js')

/**
 * A DSH_HOME whose profile carries one specific package version.
 *
 * Built at runtime rather than committed: the real layout puts the manifest
 * under `node_modules`, which .gitignore excludes, so a committed fixture
 * exists on the author's machine and nowhere else.
 */
function profileHomeWith(version: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dtui-home-'))
  const packageDirectory = join(home, 'profiles', 'tui', 'node_modules', '@dopejs', 'dsh-tui')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify({ name: '@dopejs/dsh-tui', version }, null, 2)}\n`,
  )
  return home
}

/**
 * A stub `dsh` on PATH, so the version logic is reachable without the real
 * CLI. Without it these tests would pass only on a machine that happens to
 * have dsh installed, and fail everywhere else at the availability check.
 */
function stubDshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dtui-stub-'))
  const stub = join(directory, 'dsh')
  writeFileSync(stub, '#!/bin/sh\nexit 0\n')
  chmodSync(stub, 0o755)
  return directory
}

/**
 * The launcher is a standalone script with no exports, so its behaviour is
 * exercised the way a user gets it: as a process.
 */
function runLauncher(env: Record<string, string>): { status: number, output: string } {
  // spawnSync rather than execFileSync: the launcher writes its diagnostics to
  // stderr, which the throwing variant only surfaces on a non-zero exit.
  const result = spawnSync(process.execPath, [launcher, '--doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDshDirectory()}:${process.env.PATH ?? ''}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status ?? -1,
  }
}

// The launcher declines on Windows rather than spawn `dsh.cmd` through a
// shell that would interpret its passed-through arguments.
const onPosix = process.platform === 'win32' ? describe.skip : describe

onPosix('dtui launcher (M6)', () => {
  // Refusing here is not caution: dsh applies this launcher's bundle patch to
  // the profile's older package, so starting fails on module resolution with a
  // far less obvious error than this message.
  it('refuses to start when the profile package is older than the launcher', () => {
    const result = runLauncher({ DSH_HOME: profileHomeWith('0.0.9') })
    expect(result.status).toBe(1)
    expect(result.output).toContain('Starting would apply this launcher')
    expect(result.output).toContain('dsh plugin --profile tui add')
  })

  // The newer package brings its own composition, so the launcher defers to it.
  it('warns but continues when the profile package is newer', () => {
    const result = runLauncher({ DSH_HOME: profileHomeWith('99.0.0') })
    expect(result.output).toContain('Starting the profile version')
    expect(result.output).not.toContain('Starting would apply')
  })
})
