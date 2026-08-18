import { describe, expect, it, vi } from 'vitest'

import {
  expandMessage,
  findReferences,
  resolveReferences,
  type ReferenceDependencies,
} from './reference-resolver'

const bytes = (text: string) => new TextEncoder().encode(text)

function deps(overrides: Partial<ReferenceDependencies> = {}): ReferenceDependencies {
  return {
    readFile: vi.fn(async () => bytes('file body')),
    resolveInWorkspace: (path: string) => `/repo/${path}`,
    ...overrides,
  }
}

describe('findReferences (M6.4)', () => {
  it('finds references anywhere in the message', () => {
    expect(findReferences('look at @src/a.ts and @docs/b.md please').map(r => r.path))
      .toEqual(['src/a.ts', 'docs/b.md'])
  })

  it('stops a reference at punctuation that closes it', () => {
    expect(findReferences('see (@src/a.ts), then @b.md.').map(r => r.path))
      .toEqual(['src/a.ts', 'b.md.'])
  })

  // An e-mail address is not a file reference.
  it('ignores addresses and bare markers', () => {
    expect(findReferences('mail me@example.com or just @')).toEqual([])
  })

  it('bounds how many references it will take', () => {
    const many = Array.from({ length: 50 }, (_, index) => `@f${String(index)}.txt`).join(' ')
    expect(findReferences(many, 5)).toHaveLength(5)
  })
})

describe('resolveReferences (M6.4)', () => {
  it('reads a referenced text file', async () => {
    const resolved = await resolveReferences('see @src/a.ts', deps())
    expect(resolved).toEqual([
      { kind: 'text', path: 'src/a.ts', text: 'file body', truncated: false },
    ])
  })

  // The user believes the file was sent; a silent drop is the worst outcome.
  it('refuses a reference that escapes the workspace and says why', async () => {
    const resolved = await resolveReferences('see @../secrets', deps({
      resolveInWorkspace: () => undefined,
    }))
    expect(resolved).toEqual([
      { kind: 'refused', path: '../secrets', reason: 'outside the workspace' },
    ])
  })

  it('reports an unreadable file rather than dropping it', async () => {
    const resolved = await resolveReferences('see @missing.ts', deps({
      readFile: async () => {
        throw new Error('ENOENT: no such file')
      },
    }))
    expect(resolved[0]).toMatchObject({ kind: 'refused', path: 'missing.ts' })
    expect((resolved[0] as { reason: string }).reason).toContain('ENOENT')
  })

  // A NUL in the first block is the reliable signal; sending a binary blob as
  // text would waste the window and tell the model nothing.
  it('refuses a binary file', async () => {
    const resolved = await resolveReferences('see @a.bin', deps({
      readFile: async () => new Uint8Array([0x7F, 0x45, 0x00, 0x4C]),
    }))
    expect(resolved[0]).toMatchObject({ kind: 'refused', reason: expect.stringContaining('binary') })
  })

  it('routes an image through the attachment store', async () => {
    const attachImage = vi.fn(async () => 'attach-1')
    const resolved = await resolveReferences('see @shot.png', deps({ attachImage }))
    expect(attachImage).toHaveBeenCalledWith('/repo/shot.png')
    expect(resolved[0]).toMatchObject({ attachmentId: 'attach-1', kind: 'image' })
  })

  it('refuses an image when no attachment store is mounted', async () => {
    const resolved = await resolveReferences('see @shot.png', deps())
    expect(resolved[0]).toMatchObject({
      kind: 'refused',
      reason: 'no attachment store on this Harness baseline',
    })
  })

  it('truncates an oversized text file and marks it', async () => {
    const resolved = await resolveReferences('see @big.txt', deps({
      readFile: async () => bytes('x'.repeat(100)),
    }), 10)
    expect(resolved[0]).toMatchObject({ kind: 'text', truncated: true })
    expect((resolved[0] as { text: string }).text).toHaveLength(10)
  })

  it('resolves every reference in order', async () => {
    const resolved = await resolveReferences('@a.ts then @b.ts', deps())
    expect(resolved.map(entry => entry.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('expandMessage (M6.4)', () => {
  // The model needs both what the user said and what they pointed at, so the
  // token stays in the sentence and the file follows as a labelled block.
  it('appends referenced files while leaving the sentence intact', () => {
    const expanded = expandMessage('explain @a.ts', [
      { kind: 'text', path: 'a.ts', text: 'const a = 1', truncated: false },
    ])
    expect(expanded).toContain('explain @a.ts')
    expect(expanded).toContain('<file path="a.ts">')
    expect(expanded).toContain('const a = 1')
  })

  it('marks a truncated file so the model knows it is partial', () => {
    expect(expandMessage('x', [
      { kind: 'text', path: 'a.ts', text: 'partial', truncated: true },
    ])).toContain('truncated="true"')
  })

  it('adds nothing for refused or image references', () => {
    expect(expandMessage('x', [
      { kind: 'refused', path: 'a', reason: 'outside the workspace' },
      { attachmentId: 'i', bytes: 0, kind: 'image', path: 'b.png' },
    ])).toBe('x')
  })
})
