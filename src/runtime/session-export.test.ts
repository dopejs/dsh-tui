import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

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

  it('M2.4-F05/F08 attempts every temporary cleanup and preserves the export failure first', async () => {
    const primaryFailure = new Error('temporary write failed')
    const closeFailure = new Error('temporary close failed')
    const unlinkFailure = new Error('temporary unlink failed')
    const close = vi.fn(async () => { throw closeFailure })
    const unlink = vi.fn(async () => { throw unlinkFailure })
    const fileSystem = {
      link: vi.fn(async () => undefined),
      open: vi.fn(async () => ({
        close,
        sync: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => { throw primaryFailure }),
      })),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      unlink,
    }

    let caught: unknown
    try {
      await exportRawSession({
        destination: 'copy.jsonl',
        fileSystem: fileSystem as never,
        persistence: {
          readRaw: async () => ({ content: 'raw', filename: 'source.jsonl', meta: {} }),
          supportsRawArtifacts: true,
        } as never,
        sessionId: 'session-a',
        signal: new AbortController().signal,
        workspace: '/workspace',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({
      errors: [primaryFailure, closeFailure, unlinkFailure],
      message: 'Session export failed and its temporary file could not be cleaned up',
    })
    expect(close).toHaveBeenCalledOnce()
    expect(unlink).toHaveBeenCalledOnce()
    expect(fileSystem.link).not.toHaveBeenCalled()
  })

  it('never unlinks a temporary path that exclusive creation did not acquire', async () => {
    const openFailure = Object.assign(new Error('temporary path already exists'), {
      code: 'EEXIST',
    })
    const unlink = vi.fn(async () => undefined)

    await expect(exportRawSession({
      destination: 'copy.jsonl',
      fileSystem: {
        link: vi.fn(),
        open: vi.fn(async () => { throw openFailure }),
        stat: vi.fn(async () => ({ isDirectory: () => true })),
        unlink,
      } as never,
      persistence: {
        readRaw: async () => ({ content: 'raw', filename: 'source.jsonl', meta: {} }),
        supportsRawArtifacts: true,
      } as never,
      sessionId: 'session-a',
      signal: new AbortController().signal,
      workspace: '/workspace',
    })).rejects.toBe(openFailure)
    expect(unlink).not.toHaveBeenCalled()
  })
})
