import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readClipboardImage } from './clipboard-image'

/** A temporary directory the reader will use, and then remove. */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-tui-paste-test-'))
}

describe('readClipboardImage (M7.6)', () => {
  // A person on Linux is owed the reason, and the reason is that this has not
  // been written yet -- not that their clipboard is empty.
  it('names the platform it cannot read rather than reporting nothing', async () => {
    const result = await readClipboardImage({ platform: 'linux' })
    expect(result.kind).toBe('unsupported')
    expect(result.kind === 'unsupported' && result.reason).toContain('linux')
  })

  it('reads the image the clipboard held', async () => {
    const directory = await scratch()
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const result = await readClipboardImage({
      execute: async () => {
        await writeFile(join(directory, 'clipboard.png'), bytes)
        return { stdout: 'written\n' }
      },
      platform: 'darwin',
      temporaryDirectory: async () => directory,
    })

    expect(result.kind).toBe('image')
    expect(result.kind === 'image' && [...result.image.bytes]).toEqual([...bytes])
    // Named `.png` so the attachment store can infer the media type; the file
    // itself is gone by now, and the bytes are what get attached.
    expect(result.kind === 'image' && result.image.path.endsWith('.png')).toBe(true)
  })

  // An empty clipboard is not a failure, and must not be reported as one.
  it('distinguishes an empty clipboard from a broken one', async () => {
    const empty = await readClipboardImage({
      execute: async () => ({ stdout: 'empty\n' }),
      platform: 'darwin',
      temporaryDirectory: scratch,
    })
    expect(empty.kind).toBe('empty')

    const broken = await readClipboardImage({
      execute: async () => {
        throw new Error('osascript is not installed')
      },
      platform: 'darwin',
      temporaryDirectory: scratch,
    })
    expect(broken.kind).toBe('failed')
    expect(broken.kind === 'failed' && broken.reason).toContain('osascript')
  })

  // A script that claims success but wrote nothing is an empty clipboard, not
  // an attachment of zero bytes.
  it('treats a written-but-empty file as an empty clipboard', async () => {
    const directory = await scratch()
    const result = await readClipboardImage({
      execute: async () => {
        await writeFile(join(directory, 'clipboard.png'), new Uint8Array())
        return { stdout: 'written\n' }
      },
      platform: 'darwin',
      temporaryDirectory: async () => directory,
    })
    expect(result.kind).toBe('empty')
  })
})
