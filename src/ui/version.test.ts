import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { TUI_VERSION } from './version'

describe('TUI_VERSION (M6)', () => {
  // The welcome panel shows this string. Inlining it is deliberate — the
  // published bundle has no manifest to read relative to its entry point — but
  // an inlined constant drifts silently, and a version the UI states wrongly is
  // worse than one it never shows.
  it('matches the published package version', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(TUI_VERSION).toBe(manifest.version)
  })
})
