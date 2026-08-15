import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'
import { spawn } from '@lydell/node-pty'

const DSH_VERSION = '0.1.0-rc.6'
const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-package-smoke-'))
const packDirectory = join(sandbox, 'pack')
const profileHome = join(sandbox, 'home')

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    })
  } catch (error) {
    const stdout = error?.stdout === undefined ? '' : String(error.stdout)
    const stderr = error?.stderr === undefined ? '' : String(error.stderr)
    throw new Error(
      `${command} ${args.join(' ')} failed\n${stdout}${stderr}`,
      { cause: error },
    )
  }
}

mkdirSync(packDirectory)
mkdirSync(profileHome)
run('pnpm', ['build'])
run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDirectory])
const archives = readdirSync(packDirectory).filter(name => name.endsWith('.tgz'))
if (archives.length !== 1) {
  throw new Error(`Expected one package archive, found ${String(archives.length)}`)
}
const archive = join(packDirectory, archives[0])
const environment = {
  ...process.env,
  CI: '',
  DSH_HOME: profileHome,
  DSH_TUI_LOG_FILE: join(sandbox, 'tui.log'),
  FORCE_COLOR: '0',
  TERM: 'xterm-256color',
}

run('pnpm', [
  'dlx',
  `@deepseek-ai/dsh@${DSH_VERSION}`,
  'plugin',
  '--profile',
  'tui',
  'add',
  archive,
], { env: environment })

const help = run('pnpm', [
  'dlx',
  `@deepseek-ai/dsh@${DSH_VERSION}`,
  '--profile',
  'tui',
  '--help',
], { env: environment })
if (!help.includes('dsh --profile tui') || !help.includes('--resume <session-id>')) {
  throw new Error(`Installed startup help is incomplete:\n${help}`)
}

const composed = run('pnpm', [
  'dlx',
  `@deepseek-ai/dsh@${DSH_VERSION}`,
  '--profile',
  'tui',
  '--dump-config',
], { env: environment })
for (const required of [
  "name: '@dopejs/dsh-tui/startup'",
  "name: '@dopejs/dsh-tui'",
  "name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
]) {
  if (!composed.includes(required)) throw new Error(`Composed profile is missing ${required}`)
}
for (const forbidden of [
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-client-connection',
]) {
  if (composed.includes(forbidden)) throw new Error(`TUI profile unexpectedly mounts ${forbidden}`)
}

function runTui(args) {
  const child = spawn('pnpm', [
    'dlx',
    `@deepseek-ai/dsh@${DSH_VERSION}`,
    '--profile',
    'tui',
    ...args,
  ], {
    cols: 100,
    cwd: root,
    env: environment,
    name: 'xterm-256color',
    rows: 30,
  })
  let output = ''
  child.onData((chunk) => {
    output += chunk
  })
  const exited = new Promise((resolve) => {
    child.onExit(resolve)
  })
  return { child, exited, output: () => output }
}

async function waitForScreen(running) {
  const deadline = Date.now() + 30_000
  while (!running.output().includes('dsh-tui · session-')) {
    if (Date.now() >= deadline) {
      running.child.kill()
      throw new Error(`Installed TUI did not render before timeout:\n${running.output()}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function quitAndAssert(running) {
  running.child.write('/exit')
  await new Promise(resolve => setTimeout(resolve, 50))
  running.child.write('\r')
  let timeoutHandle
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      running.child.kill()
      const diagnostic = readFileSync(environment.DSH_TUI_LOG_FILE, 'utf8')
      reject(new Error(
        `Installed TUI did not exit after /exit:\n${running.output()}\n${diagnostic}`,
      ))
    }, 10_000)
  })
  const result = await Promise.race([running.exited, timeout])
  clearTimeout(timeoutHandle)
  if (result.exitCode !== 0) {
    throw new Error(`Installed TUI exited with ${String(result.exitCode)}:\n${running.output()}`)
  }
  if (!running.output().includes('\u001B[?1049h') || !running.output().includes('\u001B[?1049l')) {
    throw new Error('Installed TUI did not enter and restore the alternate screen')
  }
}

const fresh = runTui([])
await waitForScreen(fresh)
const sessionId = /dsh-tui · (session-[^ ·\r\n]+)/.exec(fresh.output())?.[1]
if (sessionId === undefined) throw new Error('Fresh TUI did not display its session id')
await quitAndAssert(fresh)

const resumed = runTui(['--resume', sessionId])
await waitForScreen(resumed)
if (!resumed.output().includes(sessionId)) {
  throw new Error(`Resumed TUI did not display ${sessionId}`)
}
await quitAndAssert(resumed)

const manifest = JSON.parse(readFileSync(join(profileHome, 'profiles/tui/package.json'), 'utf8'))
if (!manifest.dsh?.profile?.bundles?.includes('@dopejs/dsh-tui')) {
  throw new Error('Clean profile manifest did not activate the TUI bundle')
}

process.stdout.write(`Clean profile package smoke passed in ${sandbox}\n`)
