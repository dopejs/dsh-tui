import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { exportRawSession } from './session-export'

describe('exportRawSession (M2.3)', () => {
  it('atomically creates a private export and refuses overwrite', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    try {
      const persistence = {
        readRaw: async () => ({ content: 'raw\nsession\n', filename: 'source.jsonl', meta: {} }),
        supportsRawArtifacts: true,
      }
      const request = {
        destination: 'copy.jsonl',
        persistence: persistence as never,
        sessionId: 'session-a',
        signal: new AbortController().signal,
        workspace,
      }
      await expect(exportRawSession(request)).resolves.toMatchObject({
        codeUnits: 12,
        filename: 'source.jsonl',
        path: join(workspace, 'copy.jsonl'),
      })
      expect(await readFile(join(workspace, 'copy.jsonl'), 'utf8')).toBe('raw\nsession\n')
      await expect(exportRawSession(request)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(join(workspace, 'copy.jsonl'), 'utf8')).toBe('raw\nsession\n')
    } finally {
      await rm(workspace, { recursive: true })
    }
  })

  it('fails closed for unavailable, absent, aborted, and symlink destinations', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
    try {
      const base = {
        destination: 'copy.jsonl',
        sessionId: 'session-a',
        signal: new AbortController().signal,
        workspace,
      }
      await expect(exportRawSession({
        ...base,
        persistence: { supportsRawArtifacts: false } as never,
      })).rejects.toThrow('does not expose')
      await expect(exportRawSession({
        ...base,
        persistence: { readRaw: async () => undefined, supportsRawArtifacts: true } as never,
      })).rejects.toThrow('not materialized')

      const abort = new AbortController()
      abort.abort(new Error('cancel export'))
      await expect(exportRawSession({
        ...base,
        persistence: { readRaw: async () => undefined, supportsRawArtifacts: true } as never,
        signal: abort.signal,
      })).rejects.toThrow('cancel export')

      const target = join(workspace, 'target.jsonl')
      await writeFile(target, 'keep')
      await symlink(target, join(workspace, 'copy.jsonl'))
      await expect(exportRawSession({
        ...base,
        persistence: {
          readRaw: async () => ({ content: 'replace', filename: 'source.jsonl', meta: {} }),
          supportsRawArtifacts: true,
        } as never,
      })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(target, 'utf8')).toBe('keep')
    } finally {
      await rm(workspace, { recursive: true })
    }
  })
})
