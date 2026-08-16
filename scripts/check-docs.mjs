import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const required = [
  'README.md',
  'docs/product-requirements.md',
  'docs/product-design.md',
  'docs/architecture.md',
  'docs/implementation-plan.md',
  'docs/testing-strategy.md',
  'docs/upstream-compatibility.md',
  'docs/decisions/README.md',
]

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return []
      return markdownFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  }))
  return nested.flat()
}

const failures = []
for (const path of required) {
  try {
    await access(join(root, path))
  } catch {
    failures.push(`missing required document: ${path}`)
  }
}

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g
for (const file of await markdownFiles(root)) {
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, '')
    if (target === '' || target.startsWith('#') || /^[a-z][a-z+.-]*:/i.test(target)) continue
    const path = target.split('#', 1)[0]
    try {
      await access(resolve(dirname(file), decodeURIComponent(path)))
    } catch {
      failures.push(`${relative(root, file)}: broken local link ${target}`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.log('Documentation inventory and local links are valid.')
}
