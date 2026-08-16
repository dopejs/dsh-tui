const DEFAULT_MAX_CLIPBOARD_BYTES = 100_000

export type ClipboardWriteResult = 'sent' | 'too-large' | 'unavailable'

export interface ClipboardOutput {
  readonly isTTY?: boolean
  write(chunk: string): boolean
}

export function writeOsc52Clipboard(
  output: ClipboardOutput,
  text: string,
  maximumBytes = DEFAULT_MAX_CLIPBOARD_BYTES,
): ClipboardWriteResult {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError('maximumBytes must be a positive safe integer')
  }
  if (output.isTTY !== true) return 'unavailable'
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength > maximumBytes) return 'too-large'
  try {
    output.write(`\u001B]52;c;${bytes.toString('base64')}\u0007`)
    return 'sent'
  } catch {
    return 'unavailable'
  }
}
