import { mediaTypeForPath } from './attachments-controller'

/**
 * Resolving `@path` references in a composed message.
 *
 * Completion already offers workspace paths anywhere in the message; this is
 * what happens on submit. A reference the model cannot see is worse than no
 * reference at all — the user believes the file was sent — so every reference
 * either resolves or is reported, and none is silently dropped.
 */

const MAX_REFERENCES = 20
const MAX_TEXT_BYTES = 256 * 1024

/** `@` followed by a path-ish token, anywhere in the message. */
const REFERENCE = /(?<![^\s([{])@([^\s'"`,;)\]}]+)/gu

export interface MessageReference {
  readonly end: number
  readonly path: string
  readonly start: number
}

/** Locate every `@path` reference, in message order. */
export function findReferences(message: string, maximum = MAX_REFERENCES): readonly MessageReference[] {
  const found: MessageReference[] = []
  REFERENCE.lastIndex = 0
  let match = REFERENCE.exec(message)
  while (match !== null && found.length < maximum) {
    const path = match[1] ?? ''
    // A bare `@` or an e-mail-looking token is not a file reference.
    if (path !== '' && !path.includes('@')) {
      found.push(Object.freeze({
        end: match.index + match[0].length,
        path,
        start: match.index,
      }))
    }
    match = REFERENCE.exec(message)
  }
  return Object.freeze(found)
}

export type ResolvedReference =
  | { readonly bytes: number, readonly kind: 'image', readonly path: string, readonly attachmentId: string }
  | { readonly kind: 'refused', readonly path: string, readonly reason: string }
  | { readonly kind: 'text', readonly path: string, readonly text: string, readonly truncated: boolean }

export interface ReferenceDependencies {
  /** Attach an image, returning its durable id; absent means no attachment store. */
  readonly attachImage?: (path: string) => Promise<string>
  /** Read a workspace file as bytes. Rejects for anything unreadable. */
  readonly readFile: (path: string) => Promise<Uint8Array>
  /** Resolve a reference to an absolute path, or undefined when it escapes. */
  readonly resolveInWorkspace: (path: string) => string | undefined
}

function looksBinary(bytes: Uint8Array): boolean {
  // A NUL in the first block is the cheap, reliable signal; text files do not
  // carry one and every common binary format does.
  const window = bytes.subarray(0, 8_000)
  return window.includes(0)
}

/**
 * Resolve every reference in a message.
 *
 * Resolution never throws: an unreadable, escaping, or binary file becomes a
 * `refused` entry the caller shows, because the user needs to know the file did
 * not go with the message.
 */
export async function resolveReferences(
  message: string,
  dependencies: ReferenceDependencies,
  maxTextBytes = MAX_TEXT_BYTES,
): Promise<readonly ResolvedReference[]> {
  const resolved: ResolvedReference[] = []
  for (const reference of findReferences(message)) {
    const absolute = dependencies.resolveInWorkspace(reference.path)
    if (absolute === undefined) {
      resolved.push(Object.freeze({
        kind: 'refused' as const,
        path: reference.path,
        reason: 'outside the workspace',
      }))
      continue
    }
    const mediaType = mediaTypeForPath(reference.path)
    if (mediaType !== undefined) {
      if (dependencies.attachImage === undefined) {
        resolved.push(Object.freeze({
          kind: 'refused' as const,
          path: reference.path,
          reason: 'no attachment store on this Harness baseline',
        }))
        continue
      }
      try {
        const attachmentId = await dependencies.attachImage(absolute)
        resolved.push(Object.freeze({
          attachmentId,
          bytes: 0,
          kind: 'image' as const,
          path: reference.path,
        }))
      } catch (error) {
        resolved.push(Object.freeze({
          kind: 'refused' as const,
          path: reference.path,
          reason: error instanceof Error ? error.message : String(error),
        }))
      }
      continue
    }
    try {
      const bytes = await dependencies.readFile(absolute)
      if (looksBinary(bytes)) {
        resolved.push(Object.freeze({
          kind: 'refused' as const,
          path: reference.path,
          reason: 'binary file; only text and images can be referenced',
        }))
        continue
      }
      const truncated = bytes.length > maxTextBytes
      resolved.push(Object.freeze({
        kind: 'text' as const,
        path: reference.path,
        text: new TextDecoder().decode(bytes.subarray(0, maxTextBytes)),
        truncated,
      }))
    } catch (error) {
      resolved.push(Object.freeze({
        kind: 'refused' as const,
        path: reference.path,
        reason: error instanceof Error ? error.message : String(error),
      }))
    }
  }
  return Object.freeze(resolved)
}

/**
 * Expand resolved text references into the message the model receives.
 *
 * The reference token stays in place so the sentence still reads, and the file
 * follows as a labelled block — the model needs both what the user said and
 * what they pointed at.
 */
export function expandMessage(
  message: string,
  resolved: readonly ResolvedReference[],
): string {
  const blocks = resolved
    .filter((entry): entry is Extract<ResolvedReference, { kind: 'text' }> => entry.kind === 'text')
    .map(entry => `\n\n<file path="${entry.path}"${entry.truncated ? ' truncated="true"' : ''}>\n`
      + `${entry.text}\n</file>`)
  return `${message}${blocks.join('')}`
}
