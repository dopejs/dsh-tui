import { pathToFileURL } from 'node:url'

/** OSC introducer (ESC + ']') and string terminator (ESC + '\\'). */
const OSC = '\u001B]'
const ST = '\u001B\\'

/**
 * Terminals that advertise OSC 8 hyperlink support, keyed by the environment
 * they set. A terminal that is not recognized gets plain text: a hyperlink that
 * renders as raw escape bytes is worse than no hyperlink.
 */
function detectHyperlinkSupport(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.NO_HYPERLINKS !== undefined && env.NO_HYPERLINKS !== '') return false
  if (env.TERM === 'dumb' || env.TERM === undefined) return false
  const program = env.TERM_PROGRAM
  if (program === 'iTerm.app' || program === 'WezTerm' || program === 'vscode') return true
  if (env.WT_SESSION !== undefined) return true
  if (env.KITTY_WINDOW_ID !== undefined || env.TERM === 'xterm-kitty') return true
  if (env.VTE_VERSION !== undefined && Number(env.VTE_VERSION) >= 5_000) return true
  return false
}

/**
 * Terminals that can draw inline raster images. Negotiated separately from
 * hyperlinks because a terminal may support one and not the other, and because
 * the textual fallback has to be chosen before anything is written.
 */
function detectImageSupport(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.TERM === 'dumb' || env.TERM === undefined) return false
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') return true
  return env.KITTY_WINDOW_ID !== undefined || env.TERM === 'xterm-kitty'
}

export interface TerminalCapabilities {
  readonly hyperlinks: boolean
  readonly inlineImages: boolean
}

export function detectTerminalCapabilities(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TerminalCapabilities {
  return Object.freeze({
    hyperlinks: detectHyperlinkSupport(env),
    inlineImages: detectImageSupport(env),
  })
}

/**
 * Reject text that could break out of an OSC sequence.
 *
 * OSC 8 payloads are terminated by ST or BEL, so an embedded ESC or BEL in a
 * path or label would end the sequence early and let the remainder be
 * interpreted as terminal commands. C0/C1 controls are refused outright rather
 * than escaped, because there is no safe rendering of them here.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7F || (code >= 0x80 && code <= 0x9F)) return true
  }
  return false
}

/**
 * Build a `file://` URL for an absolute path.
 *
 * `pathToFileURL` percent-encodes the path, so no shell metacharacter, quote,
 * or space is ever interpolated — the result is a URL, never a command
 * fragment, and nothing here is passed to a shell.
 */
export function fileUrlFor(absolutePath: string): string | undefined {
  if (absolutePath === '' || hasControlCharacters(absolutePath)) return undefined
  try {
    return pathToFileURL(absolutePath).href
  } catch {
    return undefined
  }
}

export interface HyperlinkOptions {
  readonly capabilities?: TerminalCapabilities
  /** Visible text; defaults to the path. */
  readonly label?: string
}

/**
 * Render an OSC 8 hyperlink to a local file, or plain text when the terminal
 * does not support hyperlinks or the path cannot be linked safely.
 *
 * The fallback is always legible text, never an empty string, so a path stays
 * visible on every terminal.
 */
export function fileHyperlink(absolutePath: string, options: HyperlinkOptions = {}): string {
  const label = options.label ?? absolutePath
  const safeLabel = hasControlCharacters(label) ? absolutePath : label
  const capabilities = options.capabilities ?? detectTerminalCapabilities()
  if (!capabilities.hyperlinks) return safeLabel
  const url = fileUrlFor(absolutePath)
  if (url === undefined || hasControlCharacters(safeLabel)) return safeLabel
  return `${OSC}8;;${url}${ST}${safeLabel}${OSC}8;;${ST}`
}

/**
 * Strip OSC 8 wrappers, leaving the visible label.
 *
 * Scanned rather than matched with a regular expression: the pattern would have
 * to carry control characters, and a scanner also lets a malformed sequence be
 * kept verbatim instead of silently swallowing the rest of the line.
 */
export function stripHyperlinks(value: string): string {
  const opener = `${OSC}8;;`
  let result = ''
  let index = 0
  for (;;) {
    const start = value.indexOf(opener, index)
    if (start < 0) return result + value.slice(index)
    result += value.slice(index, start)
    const terminator = value.indexOf(ST, start)
    // An unterminated sequence is left as-is rather than eating the remainder.
    if (terminator < 0) return result + value.slice(start)
    index = terminator + ST.length
  }
}
