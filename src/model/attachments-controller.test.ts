import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'

import {
  AttachmentsController,
  displayNameFor,
  mediaTypeForPath,
  type AttachmentService,
} from './attachments-controller'

const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 5_000_000,
  maxImagePixels: 40_000_000,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 10_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

function ref(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: id,
    bytes: 2_048,
    height: 200,
    mediaType: 'image/png',
    name: `${id}.png`,
    width: 400,
    ...overrides,
  } as ImageAttachmentRef
}

class FakeStore implements AttachmentService {
  readonly imageLimits = LIMITS
  readonly readImage = vi.fn()
  readonly saveImage = vi.fn<(input: SaveImageAttachment) => Promise<ImageAttachmentRef>>(
    async () => ref('a'),
  )
  readonly validateImage = vi.fn<(input: SaveImageAttachment) => Promise<void>>(
    async () => undefined,
  )
}

const bytes = () => new Uint8Array([1, 2, 3])
const readOk = async () => bytes()

describe('attachment helpers (M5.3)', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(mediaTypeForPath('/tmp/a.PNG')).toBe('image/png')
    expect(mediaTypeForPath('/tmp/a.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForPath('/tmp/a.webp')).toBe('image/webp')
    expect(mediaTypeForPath('/tmp/a.gif')).toBe('image/gif')
    expect(mediaTypeForPath('/tmp/a.txt')).toBeUndefined()
    expect(mediaTypeForPath('/tmp/noextension')).toBeUndefined()
  })

  // The name lands in durable session data and in the transcript.
  it('strips directory components from a display name', () => {
    expect(displayNameFor('/home/alice/secret-project/a.png')).toBe('a.png')
    expect(displayNameFor('C:\\Users\\alice\\a.png')).toBe('a.png')
    expect(displayNameFor('a.png')).toBe('a.png')
  })
})

describe('AttachmentsController (M5.3)', () => {
  it('is unavailable without the attachment store', async () => {
    const controller = new AttachmentsController()
    expect(controller.getSnapshot()).toMatchObject({ rows: [], status: 'unavailable' })
    await expect(controller.attach('/tmp/a.png', readOk)).resolves.toBe('unavailable')
    controller.dispose()
  })

  it('publishes the store limits rather than guessing at them', () => {
    const controller = new AttachmentsController(new FakeStore())
    expect(controller.getSnapshot().limits).toEqual(LIMITS)
    controller.dispose()
  })

  // Validation runs before the write, so a refused image stores nothing.
  it('validates before saving and refuses without writing', async () => {
    const store = new FakeStore()
    store.validateImage.mockRejectedValue(new Error('image exceeds maxImageBytes'))
    const controller = new AttachmentsController(store)

    await expect(controller.attach('/tmp/big.png', readOk)).resolves.toBe('refused')
    expect(store.validateImage).toHaveBeenCalled()
    expect(store.saveImage).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      error: 'image exceeds maxImageBytes',
      rows: [],
      status: 'error',
    })
    controller.dispose()
  })

  it('attaches a validated image and strips its path', async () => {
    const store = new FakeStore()
    const controller = new AttachmentsController(store)

    await expect(controller.attach('/home/alice/private/shot.png', readOk)).resolves.toBe('attached')
    expect(store.saveImage).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'image/png',
      name: 'shot.png',
    }))
    expect(JSON.stringify(store.saveImage.mock.calls[0]?.[0])).not.toContain('private')
    expect(controller.getSnapshot().rows).toHaveLength(1)
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  // The declared type is a proposal; the store checks it against the bytes.
  it('refuses an unsupported format before touching the store', async () => {
    const store = new FakeStore()
    const controller = new AttachmentsController(store)

    await expect(controller.attach('/tmp/notes.txt', readOk)).resolves.toBe('refused')
    expect(store.validateImage).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toContain('not a supported image format')
    controller.dispose()
  })

  it('reports a missing file without claiming an attachment', async () => {
    const store = new FakeStore()
    const controller = new AttachmentsController(store)
    const missing = async () => {
      throw new Error('ENOENT: no such file')
    }

    await expect(controller.attach('/tmp/gone.png', missing)).resolves.toBe('refused')
    expect(controller.getSnapshot()).toMatchObject({ rows: [], status: 'error' })
    expect(controller.getSnapshot().error).toContain('ENOENT')
    expect(store.saveImage).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('bounds how many attachments can be staged', async () => {
    const store = new FakeStore()
    let counter = 0
    store.saveImage.mockImplementation(async () => ref(`a${String(counter++)}`))
    const controller = new AttachmentsController(store, { maxAttachments: 2 })

    await controller.attach('/tmp/a.png', readOk)
    await controller.attach('/tmp/b.png', readOk)
    await expect(controller.attach('/tmp/c.png', readOk)).resolves.toBe('refused')
    expect(controller.getSnapshot().rows).toHaveLength(2)
    expect(controller.getSnapshot().error).toContain('At most 2 attachments')
    controller.dispose()
  })

  it('removes and clears staged attachments', async () => {
    const store = new FakeStore()
    let counter = 0
    store.saveImage.mockImplementation(async () => ref(`a${String(counter++)}`))
    const controller = new AttachmentsController(store)

    await controller.attach('/tmp/a.png', readOk)
    await controller.attach('/tmp/b.png', readOk)
    expect(controller.remove('a0')).toBe(true)
    expect(controller.remove('a0')).toBe(false)
    expect(controller.getSnapshot().rows.map(row => row.attachmentId)).toEqual(['a1'])
    expect(controller.clear()).toBe(true)
    expect(controller.clear()).toBe(false)
    controller.dispose()
  })

  // An attachment is never invisible on a terminal that cannot draw it.
  it('describes an attachment in text every terminal can render', () => {
    const controller = new AttachmentsController(new FakeStore(), { inlineImages: false })
    const description = controller.describe({
      attachmentId: 'a1',
      bytes: 2_048,
      height: 200,
      mediaType: 'image/png',
      name: 'shot.png',
      width: 400,
    })
    expect(description).toBe('[image shot.png · image/png · 400×200 · 2 KiB]')
    expect([...description].every(character => (character.codePointAt(0) ?? 0) >= 0x20)).toBe(true)
    expect(controller.getSnapshot().inlineImages).toBe(false)
    controller.dispose()
  })

  it('reports the negotiated inline-image capability', () => {
    const controller = new AttachmentsController(new FakeStore(), { inlineImages: true })
    expect(controller.getSnapshot().inlineImages).toBe(true)
    controller.dispose()
  })

  it('survives a store whose limits getter throws', () => {
    const store = new FakeStore()
    Object.defineProperty(store, 'imageLimits', {
      get: () => {
        throw new Error('limits unavailable')
      },
    })
    const controller = new AttachmentsController(store)
    expect(controller.getSnapshot().limits).toBeUndefined()
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    expect(() => new AttachmentsController(undefined, { maxAttachments: 0 }))
      .toThrow('maxAttachments must be a positive safe integer')
  })

  it('never updates after disposal', async () => {
    const store = new FakeStore()
    const controller = new AttachmentsController(store)
    const listener = vi.fn()
    controller.subscribe(listener)

    controller.dispose()

    expect(listener).not.toHaveBeenCalled()
    await expect(controller.attach('/tmp/a.png', readOk))
      .rejects.toThrow('AttachmentsController is disposed')
    controller.dispose()
  })
})
