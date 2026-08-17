import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'
import { spawn } from '@lydell/node-pty'

const DSH_VERSION = '0.1.0-rc.6'
const dshDlx = ['dlx', '--allow-build=node-pty', `@deepseek-ai/dsh@${DSH_VERSION}`]
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
  ...dshDlx,
  'plugin',
  '--profile',
  'tui',
  'add',
  archive,
], { env: environment })

const help = run('pnpm', [
  ...dshDlx,
  '--profile',
  'tui',
  '--help',
], { env: environment })
if (
  !help.includes('dsh --profile tui')
  || !help.includes('--resume <session-id>')
  || !help.includes('--model <provider/model>')
) {
  throw new Error(`Installed startup help is incomplete:\n${help}`)
}

const composed = run('pnpm', [
  ...dshDlx,
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


/**
 * Run a one-shot invocation against the installed profile and require that it
 * terminates on its own.
 *
 * A bound is the point of this helper. `--doctor` and `--print` once printed
 * their output and then never exited, because `appExit` requested from the
 * runtime plugin's `start` is dropped before the launcher's shutdown
 * controller exists. Without a timeout that regression hangs CI instead of
 * failing it.
 */
function runOneShot(args, { env = environment, input, timeoutMs = 120_000 } = {}) {
  const result = spawnSync('pnpm', [...dshDlx, '--profile', 'tui', ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
    ...(input === undefined ? {} : { input }),
  })
  if (result.error?.code === 'ETIMEDOUT' || result.signal !== null) {
    throw new Error(
      `dsh --profile tui ${args.join(' ')} did not exit within ${String(timeoutMs)}ms `
      + `(signal ${String(result.signal)}). A one-shot run must request exit until the `
      + `launcher honours it.\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
  if (result.error !== undefined) throw result.error
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

// --doctor is read-only: it starts no session and runs no agent.
const doctor = runOneShot(['--doctor'])
if (doctor.status !== 0) {
  throw new Error(`--doctor exited ${String(doctor.status)}:\n${doctor.stdout}${doctor.stderr}`)
}
for (const required of [
  'dsh-tui doctor',
  'Required services',
  'Session persistence',
  'Overall:',
]) {
  if (!doctor.stdout.includes(required)) {
    throw new Error(`--doctor report is missing ${required}:\n${doctor.stdout}`)
  }
}
// The report is read by screen readers and pasted into issue trackers.
if (doctor.stdout.includes('\u001B[')) {
  throw new Error('--doctor emitted ANSI escapes into a non-TTY stream')
}
if (/(?:key|secret|token|password)=/iu.test(doctor.stdout)) {
  throw new Error(`--doctor leaked an environment value:\n${doctor.stdout}`)
}

// --print must terminate, and what it reports must match what happened.
//
// The credential is stripped so the turn cannot succeed: the only correct
// outcome is a failed run. This pins the regression where a failed turn exited
// 0 reporting "completed" — the encoder skipped `turn/end`, so a caller read
// exit 0 and empty output as "the model had nothing to say".
const credentialFree = Object.fromEntries(
  Object.entries(environment).filter(
    ([name]) => !/(?:api[_-]?key|secret|token|credential)/iu.test(name),
  ),
)

const printed = runOneShot(['--print', '--output-format', 'stream-json'], {
  env: credentialFree,
  input: 'say hello\n',
})
const lines = printed.stdout.trim().split('\n').filter(Boolean)
const last = lines.at(-1)
if (last === undefined) throw new Error('--print produced no envelope')
let envelope
try {
  envelope = JSON.parse(last)
} catch {
  throw new Error(`--print did not end with a JSON envelope:\n${printed.stdout}`)
}
if (envelope.type !== 'result' || envelope.v !== 1) {
  throw new Error(`--print ended with an unexpected envelope: ${last}`)
}
if (envelope.reason !== 'failed') {
  throw new Error(
    `--print reported "${envelope.reason}" for a run that could not reach a model. `
    + `A turn that failed must not be reported as success.\n${printed.stdout}`,
  )
}
if (printed.status !== 1) {
  throw new Error(`--print reported "failed" but exited ${String(printed.status)}; expected 1`)
}
// Diagnostics belong on stderr so redirecting stdout never loses them.
if (printed.stderr.trim() === '') {
  throw new Error('--print failed without writing a diagnostic to stderr')
}

function runTui(args) {
  const child = spawn('pnpm', [
    ...dshDlx,
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

async function waitForOutput(running, text, label) {
  const deadline = Date.now() + 10_000
  while (!running.output().includes(text)) {
    if (Date.now() >= deadline) {
      running.child.kill()
      throw new Error(`Installed TUI did not ${label}:\n${running.output()}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function waitForOutputSince(running, offset, text, label) {
  const deadline = Date.now() + 10_000
  while (!running.output().slice(offset).includes(text)) {
    if (Date.now() >= deadline) {
      running.child.kill()
      throw new Error(`Installed TUI did not ${label}:\n${running.output()}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function exerciseMultilineComposer(running) {
  running.child.write('\u001B[200~first line\nsecond line\u001B[201~')
  await waitForOutput(running, 'second line', 'render bracketed multiline paste')
  if (!running.output().includes('first line')) {
    throw new Error(`Installed TUI lost the first pasted line:\n${running.output()}`)
  }
  running.child.write('\u0003')
  await waitForOutput(running, 'Composer cleared.', 'clear the multiline draft')
  running.child.write('\u0006')
  await waitForOutput(running, 'type to search retained transcript', 'open transcript search')
  running.child.write('needle')
  await waitForOutput(running, '/ needle', 'edit the transcript search query')
  running.child.write('\u001B')
  await waitForOutput(running, 'Transcript search closed.', 'close transcript search')

  let offset = running.output().length
  running.child.write('\u0010')
  await waitForOutputSince(running, offset, 'Command palette', 'open the command palette')
  offset = running.output().length
  running.child.write('\u001B')
  await waitForOutputSince(running, offset, 'Overlay closed.', 'close the command palette')

  offset = running.output().length
  running.child.write('\u000f')
  await waitForOutputSince(running, offset, 'Session center', 'open the session center')
  await waitForOutputSince(running, offset, 'Session center · ready', 'load the session center')
  offset = running.output().length
  running.child.write('\u001B')
  await waitForOutputSince(running, offset, 'Overlay closed.', 'close the session center')

  offset = running.output().length
  running.child.write('\u0010')
  await waitForOutputSince(running, offset, 'Command palette', 'open permissions discovery')
  running.child.write('open permissions')
  await waitForOutputSince(running, offset, 'Open permissions', 'discover permissions')
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(running, offset, 'Permissions · ready', 'open permissions')
  offset = running.output().length
  running.child.write('\u001B[B')
  running.child.write('\r')
  await waitForOutputSince(
    running,
    offset,
    'Type enable danger-full-access',
    'require dangerous permission confirmation',
  )
  offset = running.output().length
  running.child.write('\u001B')
  await waitForOutputSince(
    running,
    offset,
    'Dangerous permission change cancelled.',
    'cancel dangerous permission confirmation',
  )
  offset = running.output().length
  running.child.write('\u001B')
  await waitForOutputSince(running, offset, 'Overlay closed.', 'close permissions')

  offset = running.output().length
  running.child.write('\u0010')
  await waitForOutputSince(running, offset, 'Command palette', 'open changes discovery')
  running.child.write('open changes')
  await waitForOutputSince(running, offset, 'Open changes', 'discover changes')
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(running, offset, 'Changes · 0 files · 0 edits', 'open changes')
  await waitForOutputSince(
    running,
    offset,
    'No durable diff presentations in this session',
    'show empty changes state',
  )
  offset = running.output().length
  running.child.write('\u001B')
  await waitForOutputSince(running, offset, 'Overlay closed.', 'close changes')

  offset = running.output().length
  running.child.write('\u0010')
  await waitForOutputSince(running, offset, 'Command palette', 'open recovery discovery')
  running.child.write('open recovery')
  await waitForOutputSince(running, offset, 'Open recovery', 'discover recovery')
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(running, offset, 'Recovery · session-', 'open recovery')
  running.child.write('\u001B[B')
  running.child.write('\u001B[B')
  running.child.write('\u001B[B')
  await waitForOutputSince(running, offset, 'File rewind · unavailable', 'gate file rewind')
  running.child.write('\u001B[A')
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(
    running,
    offset,
    'Fork conversation only; current workspace files are not rewound.',
    'confirm the conversation-only fork boundary',
  )
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(running, offset, 'dsh-tui · session-', 'attach the conversation fork')

  offset = running.output().length
  running.child.write('/ex')
  await waitForOutputSince(running, offset, '/ex', 'render the command completion query')
  offset = running.output().length
  running.child.write('\t')
  await waitForOutputSince(running, offset, 'Command completion · ex', 'open command completion')
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(running, offset, 'Completion applied.', 'apply command completion')
  offset = running.output().length
  running.child.write('\u0003')
  await waitForOutputSince(running, offset, 'Composer cleared.', 'clear the completed command')

  running.child.write('@cord')
  await waitForOutputSince(running, offset, '@cord', 'render the path completion query')
  offset = running.output().length
  running.child.write('\t')
  await waitForOutputSince(running, offset, 'Path completion · cord', 'open path completion')
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(running, offset, '@cordis.patch.yml', 'apply workspace path completion')
  offset = running.output().length
  running.child.write('\u0003')
  await waitForOutputSince(running, offset, 'Composer cleared.', 'clear the completed path')
}

async function exerciseSessionSwitch(running, targetSessionId) {
  let offset = running.output().length
  running.child.write('\u000f')
  await waitForOutputSince(running, offset, 'Session center · ready', 'load persisted sessions')
  offset = running.output().length
  running.child.write(targetSessionId)
  await waitForOutputSince(
    running,
    offset,
    `> ${targetSessionId}`,
    'apply the target session filter',
  )
  offset = running.output().length
  running.child.write(' ')
  await waitForOutputSince(
    running,
    offset,
    `Preview ${targetSessionId}`,
    'preview the filtered target session',
  )
  offset = running.output().length
  running.child.write('\r')
  await waitForOutputSince(
    running,
    offset,
    `dsh-tui · ${targetSessionId} · idle`,
    'attach the selected persisted session',
  )
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
await exerciseMultilineComposer(fresh)
await quitAndAssert(fresh)

const switching = runTui(['--model', 'deepseek-official/deepseek-v4-flash'])
await waitForScreen(switching)
const switchingSessionId = /dsh-tui · (session-[^ ·\r\n]+)/.exec(switching.output())?.[1]
if (switchingSessionId === undefined || switchingSessionId === sessionId) {
  throw new Error('Session-switch fixture did not create a distinct initial session')
}
await exerciseSessionSwitch(switching, sessionId)
await quitAndAssert(switching)

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
