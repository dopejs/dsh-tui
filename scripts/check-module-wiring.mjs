/**
 * Fail when a module is built and tested but reachable by nobody.
 *
 * A controller can be fully implemented, fully unit-tested, and still deliver
 * nothing, because no runtime constructs it and no view renders it. That gap is
 * invisible to `tsc`, to eslint, and to the unit suites — every one of them is
 * satisfied by the module plus its own test. It cost three capabilities that
 * were documented as complete while being unreachable from the running app.
 *
 * So: every non-test module under the checked roots must be imported by some
 * module other than its own test file.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src')

/** Entry points are reached by the bundler and the loader, not by import. */
const ENTRY_POINTS = new Set(['src/index.ts', 'src/startup.ts'])

/**
 * Modules that predate the current entry points and are reachable by nobody:
 * neither is in `exports`, `bin`, the tsdown config, or the Cordis patch, and
 * only their own tests import them. They are listed rather than deleted so the
 * guard protects everything else while their removal is decided separately.
 */
const KNOWN_UNWIRED = new Set(['src/cli.tsx', 'src/runtime/agent-runtime.ts'])

const TEST = /\.(?:test|bench)\.[jt]sx?$/u

async function walk(directory, prefix) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${prefix}/${entry.name}`
    return entry.isDirectory() ? walk(join(directory, entry.name), path) : [path]
  }))
  return nested.flat()
}

const all = await walk(source, 'src')
const modules = all.filter(path => /\.tsx?$/u.test(path) && !TEST.test(path))
const importers = all.filter(path => /\.tsx?$/u.test(path))

const contents = new Map(
  await Promise.all(importers.map(async path => [
    path,
    await readFile(join(root, path), 'utf8'),
  ])),
)

/** The specifier a module is imported by, without directory or extension. */
function moduleName(path) {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.replace(/\.tsx?$/u, '')
}

const unreferenced = modules.filter((path) => {
  if (ENTRY_POINTS.has(path) || KNOWN_UNWIRED.has(path)) return false
  const name = moduleName(path)
  const ownTests = new Set([
    path.replace(/\.tsx?$/u, '.test.ts'),
    path.replace(/\.tsx?$/u, '.test.tsx'),
  ])
  for (const [importer, text] of contents) {
    // Only non-test modules count as wiring: a module imported solely by test
    // files — its own or any other — still delivers nothing to a user.
    if (importer === path || ownTests.has(importer) || TEST.test(importer)) continue
    // Local imports are extensionless by repository convention.
    if (text.includes(`/${name}'`) || text.includes(`./${name}'`)) return false
  }
  return true
})

if (unreferenced.length > 0) {
  console.error('These modules are built and tested but reachable by nobody:')
  for (const path of unreferenced) console.error(`  ${path}`)
  console.error('\nA module only its own test imports delivers no capability.')
  console.error('Wire it into the runtime and the view, or delete it.')
  process.exit(1)
}

console.log(`All ${String(modules.length)} source modules are reachable.`)
