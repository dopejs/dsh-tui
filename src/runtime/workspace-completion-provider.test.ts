import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { WorkspaceCompletionProvider } from './workspace-completion-provider'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-completion-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('WorkspaceCompletionProvider (M1.3)', () => {
  it('ranks public Harness command descriptors and preserves input hints', async () => {
    const workspace = await temporaryDirectory()
    const provider = new WorkspaceCompletionProvider({
      listCommands: () => [
        { description: 'Review changes', input: { hint: '<path>' }, name: 'review' },
        { description: 'Resume session', name: 'resume' },
      ],
      workspace,
    })

    await expect(provider.complete({
      kind: 'command',
      query: 'rvw',
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      description: 'Review changes',
      id: 'command:review',
      label: '/review',
      replacement: '/review ',
    }])
  })

  it('completes bounded relative files and directories inside the workspace', async () => {
    const workspace = await temporaryDirectory()
    await mkdir(join(workspace, 'src'))
    await mkdir(join(workspace, 'src', 'components'))
    await writeFile(join(workspace, 'src', 'controller.ts'), '')
    await writeFile(join(workspace, 'src', '.secret'), '')
    const provider = new WorkspaceCompletionProvider({
      listCommands: () => [],
      workspace,
    })

    await expect(provider.complete({
      kind: 'path',
      query: 'src/co',
      signal: new AbortController().signal,
    })).resolves.toEqual([
      {
        description: 'directory',
        id: 'path:src/components/',
        label: 'src/components/',
        replacement: 'src/components/',
      },
      {
        description: 'file',
        id: 'path:src/controller.ts',
        label: 'src/controller.ts',
        replacement: 'src/controller.ts',
      },
    ])
    await expect(provider.complete({
      kind: 'path',
      query: 'src/secret',
      signal: new AbortController().signal,
    })).resolves.toEqual([])
    await expect(provider.complete({
      kind: 'path',
      query: 'src/.s',
      signal: new AbortController().signal,
    })).resolves.toEqual([expect.objectContaining({ replacement: 'src/.secret' })])
  })

  it('fails closed for absolute, missing, aborted, and escaping paths', async () => {
    const workspace = await temporaryDirectory()
    const outside = await temporaryDirectory()
    if (process.platform !== 'win32') await symlink(outside, join(workspace, 'escape'))
    const provider = new WorkspaceCompletionProvider({
      listCommands: () => [],
      workspace,
    })

    for (const query of ['/etc/', '../', 'missing/']) {
      await expect(provider.complete({
        kind: 'path',
        query,
        signal: new AbortController().signal,
      })).resolves.toEqual([])
    }
    if (process.platform !== 'win32') {
      await expect(provider.complete({
        kind: 'path',
        query: 'escape/',
        signal: new AbortController().signal,
      })).resolves.toEqual([])
    }
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(provider.complete({
      kind: 'path',
      query: '',
      signal: abort.signal,
    })).rejects.toThrow('cancelled')
  })

  it('validates scan and result limits', async () => {
    const workspace = await temporaryDirectory()
    expect(() => new WorkspaceCompletionProvider({
      listCommands: () => [],
      maxDirectoryEntries: 0,
      workspace,
    })).toThrow('maxDirectoryEntries')
    expect(() => new WorkspaceCompletionProvider({
      listCommands: () => [],
      maxResults: 0,
      workspace,
    })).toThrow('maxResults')
  })
})
