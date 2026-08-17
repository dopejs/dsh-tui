import { describe, expect, it } from 'vitest'

import {
  detectTerminalCapabilities,
  fileHyperlink,
  fileUrlFor,
  stripHyperlinks,
} from './terminal-links'

const ESC = '\u001B'
const BEL = '\u0007'
const LINKING = { hyperlinks: true, inlineImages: false }
const PLAIN = { hyperlinks: false, inlineImages: false }

describe('terminal capability negotiation (M5.3)', () => {
  it.each([
    ['iTerm2', { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }],
    ['WezTerm', { TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm' }],
    ['VS Code', { TERM: 'xterm-256color', TERM_PROGRAM: 'vscode' }],
    ['Windows Terminal', { TERM: 'xterm-256color', WT_SESSION: '1' }],
    ['kitty', { TERM: 'xterm-kitty' }],
    ['modern VTE', { TERM: 'xterm-256color', VTE_VERSION: '6003' }],
  ])('detects hyperlink support in %s', (_name, env) => {
    expect(detectTerminalCapabilities(env).hyperlinks).toBe(true)
  })

  // An unrecognized terminal renders the escape bytes as garbage, which is
  // worse than showing the path plainly.
  it.each([
    ['a dumb terminal', { TERM: 'dumb' }],
    ['no TERM at all', {}],
    ['an unknown terminal', { TERM: 'xterm-256color' }],
    ['an old VTE', { TERM: 'xterm-256color', VTE_VERSION: '4200' }],
  ])('assumes no hyperlink support for %s', (_name, env) => {
    expect(detectTerminalCapabilities(env).hyperlinks).toBe(false)
  })

  it('honours an explicit opt-out', () => {
    expect(detectTerminalCapabilities({
      NO_HYPERLINKS: '1',
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'iTerm.app',
    }).hyperlinks).toBe(false)
  })

  // Inline images and hyperlinks are separate capabilities; a terminal may
  // support one without the other.
  it('negotiates inline images separately from hyperlinks', () => {
    expect(detectTerminalCapabilities({ TERM: 'xterm-256color', WT_SESSION: '1' }))
      .toEqual({ hyperlinks: true, inlineImages: false })
    expect(detectTerminalCapabilities({ TERM: 'xterm-kitty' }))
      .toEqual({ hyperlinks: true, inlineImages: true })
    expect(detectTerminalCapabilities({ TERM: 'dumb' }))
      .toEqual({ hyperlinks: false, inlineImages: false })
  })
})

describe('file URLs (M5.3)', () => {
  // The path becomes a URL the terminal opens; it is never handed to a shell,
  // so shell metacharacters are ordinary path bytes here. What matters is that
  // the result stays one well-formed URL token with no sequence-breaking bytes.
  it('produces one well-formed URL token from a hostile-looking path', () => {
    const url = fileUrlFor('/tmp/a b;rm -rf ~/$(whoami)&x.txt')
    expect(url).toBeDefined()
    expect(url?.startsWith('file:///')).toBe(true)
    expect(url).toContain('%20')
    // A space would split the OSC 8 URI field; control bytes would end it.
    expect(url).not.toContain(' ')
    expect([...(url ?? '')].every(character => (character.codePointAt(0) ?? 0) >= 0x20))
      .toBe(true)
    expect(() => new URL(url ?? '')).not.toThrow()
  })

  it('handles unicode paths', () => {
    expect(fileUrlFor('/tmp/文档.txt')).toContain('%E6%96%87')
  })

  // ESC or BEL inside an OSC payload terminates the sequence early and lets the
  // remainder be read as terminal commands.
  it('refuses a path carrying control characters', () => {
    expect(fileUrlFor(`/tmp/evil${ESC}]0;pwned.txt`)).toBeUndefined()
    expect(fileUrlFor(`/tmp/bell${BEL}.txt`)).toBeUndefined()
    expect(fileUrlFor('/tmp/newline\n.txt')).toBeUndefined()
    expect(fileUrlFor('')).toBeUndefined()
  })
})

describe('fileHyperlink (M5.3)', () => {
  // The URL is resolved with the platform's path semantics — on Windows an
  // absolute POSIX path picks up the current drive — so the structure is
  // asserted rather than a hardcoded POSIX URL.
  it('wraps the label in an OSC 8 sequence on a capable terminal', () => {
    const link = fileHyperlink('/tmp/report.md', {
      capabilities: LINKING,
      label: 'report.md',
    })
    const url = fileUrlFor('/tmp/report.md')
    expect(url).toBeDefined()
    expect(link).toBe(`${ESC}]8;;${String(url)}${ESC}\\report.md${ESC}]8;;${ESC}\\`)
    expect(url?.startsWith('file:///')).toBe(true)
    expect(url?.endsWith('/report.md')).toBe(true)
    expect(stripHyperlinks(link)).toBe('report.md')
  })

  it('falls back to legible text on a terminal without hyperlinks', () => {
    expect(fileHyperlink('/tmp/report.md', { capabilities: PLAIN, label: 'report.md' }))
      .toBe('report.md')
    expect(fileHyperlink('/tmp/report.md', { capabilities: PLAIN })).toBe('/tmp/report.md')
  })

  // The fallback is never empty: a path stays visible on every terminal.
  it('emits the path rather than nothing when it cannot be linked', () => {
    const evil = `/tmp/evil${ESC}]0;pwned.txt`
    const rendered = fileHyperlink(evil, { capabilities: LINKING })
    expect(rendered).toBe(evil)
    expect(rendered).not.toContain(']8;;')
  })

  it('refuses a label carrying control characters and shows the path instead', () => {
    const rendered = fileHyperlink('/tmp/ok.txt', {
      capabilities: LINKING,
      label: `nice${ESC}]0;pwned`,
    })
    expect(rendered).toContain('/tmp/ok.txt')
    expect(rendered).not.toContain('pwned')
  })

  it('strips wrappers without touching plain text', () => {
    expect(stripHyperlinks('no links here')).toBe('no links here')
    const two = fileHyperlink('/a.txt', { capabilities: LINKING })
      + ' and '
      + fileHyperlink('/b.txt', { capabilities: LINKING })
    expect(stripHyperlinks(two)).toBe('/a.txt and /b.txt')
  })
})
