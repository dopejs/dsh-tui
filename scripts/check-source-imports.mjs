import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectories = ['src', 'benchmarks', 'test-fixtures']
const sourceExtensions = new Set(['.ts', '.tsx'])
const explicitSourceExtension = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+\.(?:js|jsx|ts|tsx))['"]/g
const launcherImport = /(?:^|\/)bin\/[^/]+\.js$/

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : []
  }))
  return nested.flat()
}

const failures = []
for (const directory of sourceDirectories) {
  for (const file of await sourceFiles(join(root, directory))) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(explicitSourceExtension)) {
      // `bin/` is unbundled runtime ESM that Node loads directly, so its
      // specifiers must carry the extension. A test reaching into it has to
      // spell the path the way the launcher does, or it would be asserting
      // against a module the launcher cannot itself import.
      if (launcherImport.test(match[1])) continue
      failures.push(`${relative(root, file)}: local source import must omit the extension: ${match[1]}`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.log('Local TypeScript imports use extensionless specifiers.')
}
