/**
 * Install-path gate.
 *
 * `pnpm check` and the clean-profile smoke both resolve against the dependency
 * tree this repository pins. A user does not: they run npm against the registry
 * as it stands today, and they run it globally, because `dtui` is a global
 * command. Both escapes this gate exists for came from that gap.
 *
 *   0.2.0 pinned exact Harness peers. Upstream published a new release
 *   candidate, `latest` moved, and the documented install became ERESOLVE.
 *
 *   0.2.1 widened the ranges, which fixed the local install and turned the
 *   global one into an arborist crash: npm tried to satisfy twenty Harness
 *   peers at the global root. Nothing ever satisfies them there -- a profile
 *   installs four small packages and takes the Harness runtime from the dsh
 *   CLI's own tree -- so they are declared optional and npm no longer tries.
 *
 * This runs both installs against the host's current `latest` under npm's
 * strict peer resolution, and asserts the launcher lands on PATH.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-tui-install-path-'))
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
const archive = join(packDirectory, archives[0])

// No --legacy-peer-deps anywhere below: strict resolution is the whole point.
const common = ['--no-audit', '--no-fund']

// The global install is how a user gets `dtui`. This is the path that broke.
const globalPrefix = join(sandbox, 'global')
execFileSync('npm', ['install', '--global', '--prefix', globalPrefix, ...common,
  archive, '@deepseek-ai/dsh@latest'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const command of ['dtui', 'dsh']) {
  if (!existsSync(join(globalPrefix, 'bin', command))) {
    throw new Error(`Global install did not put \`${command}\` on PATH`)
  }
}

// The local install is how a project depends on the plugin directly.
const project = join(sandbox, 'project')
mkdirSync(project)
writeFileSync(join(project, 'package.json'), `${JSON.stringify({
  name: 'dsh-tui-install-path-probe',
  private: true,
  version: '0.0.0',
}, null, 2)}\n`)
execFileSync('npm', ['install', '--dry-run', ...common, archive, '@deepseek-ai/dsh@latest'], {
  cwd: project,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})

process.stdout.write(
  'Global and local installs resolve against @deepseek-ai/dsh@latest; `dtui` is on PATH.\n',
)
