/**
 * Fail when a built artifact would not be published.
 *
 * The bundler extracts code shared between `index` and `startup` into a
 * content-hashed chunk. A `files` list that names only the entry points ships a
 * package whose entry points import a module that is not there — and nothing
 * catches it until an install, because building and type-checking both run
 * against the untrimmed working tree.
 *
 * The `files` patterns are evaluated directly rather than by shelling out to
 * `npm pack`: that runs `prepare`/`prepack`, which run this check, which would
 * recurse.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Emitted files that are deliberately not published. */
const EXCLUDED = /\.map$/u

/**
 * Translate one npm `files` pattern into a matcher.
 *
 * Only the constructs this package uses are supported — `**`, `*`, and literal
 * segments. An unsupported construct throws rather than silently matching
 * nothing, which would turn this into a check that always passes.
 */
function matcherFor(pattern) {
  if (/[?[\]{}!+@]/u.test(pattern)) {
    throw new Error(`Unsupported glob construct in "files" pattern: ${pattern}`)
  }
  // A bare directory in npm's `files` includes everything under it.
  const normalized = pattern.endsWith('/') ? `${pattern}**` : pattern
  const segments = normalized.split('/')
  let source = ''
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      // `**` spans zero or more directories, so `lib/**/*.js` covers
      // `lib/index.js` as well as `lib/nested/index.js`.
      source += last ? '.*' : '(?:[^/]+/)*'
      return
    }
    source += segment
      .replaceAll(/[.+^${}()|\\]/gu, String.raw`\$&`)
      .replaceAll('*', '[^/]*')
    if (!last) source += '/'
  })
  const expression = new RegExp(`^${source}(?:/.*)?$`, 'u')
  return path => expression.test(path)
}

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

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const patterns = manifest.files ?? []
if (patterns.length === 0) {
  console.error('package.json has no "files" list; every built file would ship implicitly.')
  process.exit(1)
}

const emitted = (await walk(join(root, 'lib'), 'lib')).filter(path => !EXCLUDED.test(path))
if (emitted.length === 0) {
  console.error('No build output found in lib/. Run `pnpm build` before this check.')
  process.exit(1)
}

const matchers = patterns.map(pattern => matcherFor(pattern))
const missing = emitted.filter(path => !matchers.some(matches => matches(path)))

if (missing.length > 0) {
  console.error('These built files would not be published:')
  for (const path of missing) console.error(`  ${path}`)
  console.error('\nAdd them to "files" in package.json — a shared bundler chunk')
  console.error('that is emitted but not packed breaks the published package.')
  process.exit(1)
}

console.log(`All ${String(emitted.length)} built files are covered by "files".`)
