/**
 * Peer-range drift gate.
 *
 * `pnpm check` and the clean-profile smoke both resolve against the dependency
 * tree this repository pins. A user does not: they run npm against the registry
 * as it stands today. When upstream publishes a new release, an exact peer pin
 * that was correct at authoring time becomes an ERESOLVE the moment the host's
 * `latest` moves — the package publishes green and is uninstallable.
 *
 * This installs the real tarball beside the host's current `latest`, the way the
 * README tells a new user to, and fails if npm cannot resolve it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-peer-resolution-'))
const packDirectory = join(sandbox, 'pack')
mkdirSync(packDirectory)

execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDirectory], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
})
const archives = readdirSync(packDirectory).filter(name => name.endsWith('.tgz'))
if (archives.length !== 1) {
  throw new Error(`Expected one package archive, found ${String(archives.length)}`)
}

writeFileSync(join(sandbox, 'package.json'), `${JSON.stringify({
  name: 'dsh-tui-peer-resolution-probe',
  private: true,
  version: '0.0.0',
}, null, 2)}\n`)

// --dry-run still runs the full resolver; it just skips writing node_modules.
// Strict peer resolution is the point, so no --legacy-peer-deps here.
const result = execFileSync('npm', [
  'install',
  '--dry-run',
  '--no-audit',
  '--no-fund',
  `./${archives[0]}`.replace('./', `${packDirectory}/`),
  '@deepseek-ai/dsh@latest',
], {
  cwd: sandbox,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})

process.stdout.write(
  `Peer ranges resolve against @deepseek-ai/dsh@latest.\n${result.trim().split('\n').slice(-1)[0]}\n`,
)
