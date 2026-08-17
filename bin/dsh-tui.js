#!/usr/bin/env node
/**
 * One-command launcher for the `tui` profile.
 *
 * Without it, starting the TUI means naming the CLI, its version, a native
 * build allowance, and the profile:
 *
 *   pnpm dlx --allow-build=node-pty @deepseek-ai/dsh@0.1.0-rc.6 --profile tui
 *
 * This resolves the same thing from `dtui`, bootstrapping the profile on first
 * run. The launcher approach — and the version-skew handling in particular —
 * follows the pattern established by @deepseek-harness-tui/dsh-tui (MIT).
 *
 * It deliberately imports nothing from `lib/`: a launcher that cannot start
 * because the build it is meant to launch is broken has no way to say so.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const OWN_VERSION = manifest.version
const PACKAGE = manifest.name
const PROFILE = 'tui'

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function has(command) {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore' })
  return probe.error === undefined && probe.status === 0
}

// Windows resolves `dsh` as `dsh.cmd`, which Node cannot spawn without a
// shell — and a shell would interpret the arguments this launcher passes
// through, which come from the user. Rather than take that injection surface,
// the launcher declines and names the direct command.
if (process.platform === 'win32') {
  fail(
    `[${PROFILE}] The launcher does not support Windows yet. Run the profile directly:\n`
    + `  dsh --profile ${PROFILE}`,
  )
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDirectory = join(dshHome, 'profiles', PROFILE)
const installedManifest = join(profileDirectory, 'node_modules', PACKAGE, 'package.json')

if (!has('dsh')) {
  fail(
    `[${PROFILE}] The dsh CLI was not found. Install it first:\n`
    + '  npm install -g @deepseek-ai/dsh',
  )
}

function installedVersion() {
  if (!existsSync(installedManifest)) return undefined
  try {
    return JSON.parse(readFileSync(installedManifest, 'utf8')).version
  } catch {
    return undefined
  }
}

/** Compare two semver-ish versions; prerelease suffixes order before release. */
function compare(left, right) {
  const parse = value => value.split('-')[0].split('.').map(Number)
  const [leftCore, rightCore] = [parse(left), parse(right)]
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftCore[index] ?? 0) - (rightCore[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  const leftPre = left.includes('-')
  const rightPre = right.includes('-')
  if (leftPre === rightPre) return 0
  return leftPre ? -1 : 1
}

function bootstrap() {
  if (!has('pnpm')) {
    fail(
      `[${PROFILE}] First-run setup needs pnpm, which dsh delegates installs to:\n`
      + '  npm install -g pnpm    (or: corepack enable pnpm)',
    )
  }
  process.stderr.write(
    `[${PROFILE}] First run — initializing the ${PROFILE} profile `
    + `(${PACKAGE}@${OWN_VERSION})…\n`,
  )
  // Pin the version to this launcher's own, so a warm pnpm store cannot
  // resolve an older package than the launcher was built against.
  const added = spawnSync(
    'dsh',
    ['plugin', '--profile', PROFILE, 'add', `${PACKAGE}@${OWN_VERSION}`],
    { stdio: 'inherit' },
  )
  if (added.status !== 0) {
    fail(
      `[${PROFILE}] Profile initialization failed. Run it directly to see why:\n`
      + `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${OWN_VERSION}`,
      added.status ?? 1,
    )
  }
}

const present = installedVersion()
if (present === undefined) {
  bootstrap()
} else if (present !== OWN_VERSION) {
  const order = compare(present, OWN_VERSION)
  if (order > 0) {
    // The profile is ahead. The launcher still starts it; the newer package
    // brings its own composition.
    process.stderr.write(
      `[${PROFILE}] Profile has ${PACKAGE}@${present}, launcher is ${OWN_VERSION}. `
      + 'Starting the profile version.\n',
    )
  } else {
    // The profile is behind. Refusing is not caution: dsh applies this
    // launcher's bundle patch to the profile's older package, so starting
    // would fail on module resolution with a far less obvious error.
    fail(
      `[${PROFILE}] Profile has ${PACKAGE}@${present}, launcher is ${OWN_VERSION}. `
      + 'Starting would apply this launcher\'s bundle patch to the older package '
      + 'and fail on module resolution. Align them with:\n'
      + `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${OWN_VERSION}`,
    )
  }
}

const child = spawn('dsh', ['--profile', PROFILE, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
child.on('error', (error) => {
  fail(`[${PROFILE}] Could not start dsh: ${error.message}`)
})
child.on('exit', (code, signal) => {
  // Re-raise a signal rather than translating it, so Ctrl-C behaves the way
  // the shell expects from a foreground process.
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
