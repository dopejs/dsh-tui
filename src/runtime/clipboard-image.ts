/**
 * Reading an image out of the system clipboard.
 *
 * Terminals deliver text on paste and nothing else: an image on the clipboard
 * is invisible to a program reading stdin, so Ctrl-V can only work by asking
 * the operating system directly.
 *
 * Every path here reports why it could not produce an image rather than
 * returning nothing. "There is no image on the clipboard" and "this system has
 * no way to look" call for different reactions from the person who pressed the
 * key, and a single silent failure would hide both.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Bytes plus the name the attachment store will infer a media type from. */
export interface ClipboardImage {
  readonly bytes: Uint8Array
  readonly path: string
}

export type ClipboardImageResult =
  | { readonly kind: 'image', readonly image: ClipboardImage }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unsupported', readonly reason: string }
  | { readonly kind: 'failed', readonly reason: string }

export interface ClipboardImageReaderOptions {
  /** Injected so the behaviour can be tested without a clipboard. */
  readonly execute?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>
  readonly platform?: NodeJS.Platform
  readonly temporaryDirectory?: () => Promise<string>
}

/**
 * AppleScript is asked for the clipboard's PNG representation and writes it to
 * a file, because a PNG carried through a pipe as text does not survive: the
 * shell's encoding mangles it, and `osascript` has no binary output mode.
 */
const MACOS_SCRIPT = (destination: string) => `
set destination to POSIX file "${destination}"
try
  set imageData to the clipboard as «class PNGf»
on error
  return "empty"
end try
set handle to open for access destination with write permission
set eof handle to 0
write imageData to handle
close access handle
return "written"
`

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readClipboardImage(
  options: ClipboardImageReaderOptions = {},
): Promise<ClipboardImageResult> {
  const platform = options.platform ?? process.platform
  const execute = options.execute ?? (async (file, args) => run(file, [...args]))

  if (platform !== 'darwin') {
    // Named rather than implied: a user on Linux is owed the reason, and the
    // reason is that this has not been written yet, not that their clipboard
    // is empty.
    return {
      kind: 'unsupported',
      reason: `pasting an image is implemented for macOS only, not ${platform}`,
    }
  }

  let directory: string | undefined
  try {
    directory = options.temporaryDirectory === undefined
      ? await mkdtemp(join(tmpdir(), 'dsh-tui-paste-'))
      : await options.temporaryDirectory()
    const destination = join(directory, 'clipboard.png')
    const { stdout } = await execute('osascript', ['-e', MACOS_SCRIPT(destination)])
    if (stdout.trim() === 'empty') return { kind: 'empty' }
    const bytes = new Uint8Array(await readFile(destination))
    if (bytes.length === 0) return { kind: 'empty' }
    return { image: { bytes, path: destination }, kind: 'image' }
  } catch (error) {
    return { kind: 'failed', reason: reasonOf(error) }
  } finally {
    // The bytes are already read; the file was only ever a way past the pipe.
    if (directory !== undefined) await rm(directory, { force: true, recursive: true })
  }
}
