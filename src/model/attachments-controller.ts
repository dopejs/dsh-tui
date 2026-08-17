import type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'

const DEFAULT_MAX_ATTACHMENTS = 20
const MAX_TEXT_CODE_UNITS = 300

type Listener = () => void

export interface AttachmentRow {
  readonly attachmentId: string
  readonly bytes: number
  readonly height: number
  readonly mediaType: ImageMediaType
  readonly name?: string
  readonly width: number
}

export interface AttachmentsSnapshot {
  readonly error?: string
  /** Whether the terminal can draw the image; the textual row is shown either way. */
  readonly inlineImages: boolean
  readonly limits?: ImageAttachmentLimits
  readonly revision: number
  readonly rows: readonly AttachmentRow[]
  readonly status: 'busy' | 'error' | 'ready' | 'unavailable'
}

export interface AttachmentsControllerOptions {
  /** Terminal image capability, negotiated once before anything is rendered. */
  readonly inlineImages?: boolean
  readonly maxAttachments?: number
  readonly reportError?: (error: unknown) => void
}

/** The store seams this controller consumes; all reads and one guarded write. */
export type AttachmentService = Pick<
  AttachmentStore,
  'imageLimits' | 'readImage' | 'saveImage' | 'validateImage'
>

const MEDIA_BY_EXTENSION: Readonly<Record<string, ImageMediaType>> = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function boundedText(value: string, maximum = MAX_TEXT_CODE_UNITS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function errorMessage(error: unknown): string {
  try {
    return boundedText(error instanceof Error ? error.message : String(error), 500)
  } catch {
    return '<unrenderable attachment failure>'
  }
}

/**
 * Infer the media type from a file extension. The declared type is only a
 * proposal: the store verifies it against the decoded bytes and rejects a
 * mismatch, so a renamed file cannot smuggle a different format through.
 */
export function mediaTypeForPath(path: string): ImageMediaType | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  return MEDIA_BY_EXTENSION[path.slice(dot).toLowerCase()]
}

/**
 * Strip every directory component from a display name.
 *
 * The store documents that a name is never interpreted as a path, but the name
 * is also rendered in the transcript, so leaking the user's directory layout
 * into durable session data is avoided here too.
 */
export function displayNameFor(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return boundedText(separator < 0 ? path : path.slice(separator + 1), 200)
}

export class AttachmentsController {
  readonly #listeners = new Set<Listener>()
  readonly #maxAttachments: number
  readonly #reportError: (error: unknown) => void
  readonly #service: AttachmentService | undefined
  #busy = false
  #disposed = false
  #error: string | undefined
  #inlineImages: boolean
  #revision = 0
  #rows: readonly AttachmentRow[] = Object.freeze([])
  #snapshot: AttachmentsSnapshot

  constructor(service?: AttachmentService, options: AttachmentsControllerOptions = {}) {
    this.#service = service
    this.#inlineImages = options.inlineImages ?? false
    this.#maxAttachments = positiveLimit(
      options.maxAttachments,
      DEFAULT_MAX_ATTACHMENTS,
      'maxAttachments',
    )
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot()
  }

  getSnapshot = (): AttachmentsSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Validate and commit one image.
   *
   * Admission is the store's decision, not this controller's: `validateImage`
   * runs before `saveImage` so an oversized or wrong-format file is refused
   * without writing anything. Size limits are the store's published
   * `imageLimits`, never a number guessed here.
   */
  async attach(
    path: string,
    read: (path: string) => Promise<Uint8Array>,
  ): Promise<'attached' | 'refused' | 'unavailable'> {
    this.#assertActive()
    const service = this.#service
    if (service === undefined) return 'unavailable'
    if (this.#rows.length >= this.#maxAttachments) {
      this.#recordError(new Error(
        `At most ${String(this.#maxAttachments)} attachments can be staged at once`,
      ))
      return 'refused'
    }
    const mediaType = mediaTypeForPath(path)
    if (mediaType === undefined) {
      this.#recordError(new Error(`${displayNameFor(path)} is not a supported image format`))
      return 'refused'
    }
    this.#busy = true
    this.#publish()
    try {
      const data = await read(path)
      const input: SaveImageAttachment = {
        data,
        mediaType,
        name: displayNameFor(path),
      }
      // The store verifies the declared type against the decoded bytes.
      await service.validateImage(input)
      const ref = await service.saveImage(input)
      if (this.#disposed) return 'refused'
      this.#rows = Object.freeze([...this.#rows, this.#toRow(ref)])
      this.#error = undefined
      return 'attached'
    } catch (error) {
      if (this.#disposed) return 'refused'
      this.#recordError(error)
      return 'refused'
    } finally {
      this.#busy = false
      if (!this.#disposed) this.#publish()
    }
  }

  /** Drop one staged attachment. The stored object itself is immutable. */
  remove(attachmentId: string): boolean {
    this.#assertActive()
    const next = this.#rows.filter(row => row.attachmentId !== attachmentId)
    if (next.length === this.#rows.length) return false
    this.#rows = Object.freeze(next)
    this.#publish()
    return true
  }

  clear(): boolean {
    this.#assertActive()
    if (this.#rows.length === 0) return false
    this.#rows = Object.freeze([])
    this.#publish()
    return true
  }

  /**
   * A one-line description of an attachment that every terminal can render.
   *
   * This is the fallback an unsupported terminal shows, and it is also what the
   * plain-text transcript projection carries — so an attachment is never
   * invisible, only less rich.
   */
  describe(row: AttachmentRow): string {
    const size = `${String(Math.ceil(row.bytes / 1024))} KiB`
    const name = row.name ?? row.attachmentId
    return `[image ${name} · ${row.mediaType} · ${String(row.width)}×${String(row.height)} · ${size}]`
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('AttachmentsController is disposed')
  }

  #toRow(ref: ImageAttachmentRef): AttachmentRow {
    return Object.freeze({
      attachmentId: boundedText(String(ref.attachmentId), 200),
      bytes: ref.bytes,
      height: ref.height,
      mediaType: ref.mediaType,
      ...(ref.name === undefined ? {} : { name: boundedText(ref.name, 200) }),
      width: ref.width,
    })
  }

  /** Publishes, so a refusal taken before the run's `finally` is still visible. */
  #recordError(error: unknown): void {
    this.#error = errorMessage(error)
    this.#reportError(error)
    this.#publish()
  }

  #publish(): void {
    if (this.#disposed) return
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of [...this.#listeners]) listener()
  }

  #createSnapshot(): AttachmentsSnapshot {
    const service = this.#service
    const status: AttachmentsSnapshot['status'] = service === undefined
      ? 'unavailable'
      : this.#error !== undefined
        ? 'error'
        : this.#busy ? 'busy' : 'ready'
    let limits: ImageAttachmentLimits | undefined
    try {
      limits = service?.imageLimits
    } catch {
      limits = undefined
    }
    return Object.freeze({
      ...(this.#error === undefined ? {} : { error: this.#error }),
      inlineImages: this.#inlineImages,
      ...(limits === undefined ? {} : { limits }),
      revision: this.#revision,
      rows: this.#rows,
      status,
    })
  }
}
