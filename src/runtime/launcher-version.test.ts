import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
 *
 * It records every invocation, because the realignment path is only correct if
 * the launcher actually runs the install — a message saying it realigned while
 * doing nothing would otherwise pass.
 */
function stubDshDirectory(): { directory: string, log: string } {
  const directory = mkdtempSync(join(tmpdir(), 'dtui-stub-'))
  const log = join(directory, 'invocations')
  const stub = join(directory, 'dsh')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`)
  chmodSync(stub, 0o755)
  return { directory, log }
}

/**
 * The launcher is a standalone script with no exports, so its behaviour is
 * exercised the way a user gets it: as a process.
 */
function runLauncher(
  env: Record<string, string>,
): { status: number, output: string, invocations: string } {
  const stub = stubDshDirectory()
  // spawnSync rather than execFileSync: the launcher writes its diagnostics to
  // stderr, which the throwing variant only surfaces on a non-zero exit.
  const result = spawnSync(process.execPath, [launcher, '--doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stub.directory}:${process.env.PATH ?? ''}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return {
    invocations: existsSync(stub.log) ? readFileSync(stub.log, 'utf8') : '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status ?? -1,
  }
}

// The launcher declines on Windows rather than spawn `dsh.cmd` through a
// shell that would interpret its passed-through arguments.
const onPosix = process.platform === 'win32' ? describe.skip : describe

onPosix('dtui launcher (M6)', () => {
  // `npm i -g` upgrades the launcher and moves nothing else, so an older
  // profile is what every upgrade looks like. Starting it as-is is not an
  // option -- dsh applies this launcher's bundle patch to the older package
  // and fails on module resolution -- but realigning is one unambiguous
  // action, and printing it for the user to retype is a chore, not a
  // safeguard.
  it('realigns a profile older than the launcher instead of refusing', () => {
    const version = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { version: string }
    const result = runLauncher({ DSH_HOME: profileHomeWith('0.0.9') })
    expect(result.output).toContain('realigning')
    expect(result.output).not.toContain('Starting would apply')
    // The message alone would pass while doing nothing.
    expect(result.invocations)
      .toContain(`plugin --profile tui add @dopejs/dsh-tui@${version.version}`)
    expect(result.status).toBe(0)
  })

  // The newer package brings its own composition, so the launcher defers to it.
  it('warns but continues when the profile package is newer', () => {
    const result = runLauncher({ DSH_HOME: profileHomeWith('99.0.0') })
    expect(result.output).toContain('Starting the profile version')
    expect(result.output).not.toContain('Starting would apply')
  })
})
