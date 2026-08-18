/**
 * A bounded, line-oriented Markdown reader for assistant output.
 *
 * This is deliberately not a full CommonMark implementation. Its input is
 * untrusted model output rendered into a terminal, so it favours three
 * properties over completeness: it never throws, it never grows without bound,
 * and an unterminated construct degrades to plain text rather than swallowing
 * the rest of the message.
 */

const DEFAULT_MAX_BLOCKS = 500
const DEFAULT_MAX_CODE_LINES = 400
const DEFAULT_MAX_SPANS = 200

export type MarkdownBlock =
  | { readonly kind: 'code', readonly language?: string, readonly lines: readonly string[], readonly unterminated: boolean }
  | { readonly kind: 'heading', readonly level: number, readonly text: string }
  | { readonly kind: 'list', readonly items: readonly { readonly depth: number, readonly marker: string, readonly text: string }[] }
  | { readonly kind: 'paragraph', readonly text: string }
  | { readonly kind: 'quote', readonly lines: readonly string[] }
  | { readonly kind: 'rule' }

export interface MarkdownLimits {
  readonly maxBlocks?: number
  readonly maxCodeLines?: number
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/u
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u
const BULLET = /^(\s*)([-*+])\s+(.*)$/u
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/u
const QUOTE = /^\s{0,3}>\s?(.*)$/u

function limit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

/**
 * Split source into blocks.
 *
 * @param source - assistant text, verbatim.
 * @param limits - bounds; exceeding them truncates rather than throwing.
 */
export function parseMarkdown(source: string, limits: MarkdownLimits = {}): readonly MarkdownBlock[] {
  const maxBlocks = limit(limits.maxBlocks, DEFAULT_MAX_BLOCKS, 'maxBlocks')
  const maxCodeLines = limit(limits.maxCodeLines, DEFAULT_MAX_CODE_LINES, 'maxCodeLines')
  const lines = source.split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  const atCapacity = () => blocks.length >= maxBlocks

  while (index < lines.length && !atCapacity()) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      // The fence character, used to require a matching closer.
      const fenceChar = marker.slice(0, 1)
      const language = fence[2] === undefined || fence[2] === '' ? undefined : fence[2]
      const body: string[] = []
      index += 1
      let terminated = false
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        // Only a fence of the same character closes the block.
        if (candidate.trimStart().startsWith(fenceChar.repeat(3))) {
          terminated = true
          index += 1
          break
        }
        if (body.length < maxCodeLines) body.push(candidate)
        index += 1
      }
      blocks.push(Object.freeze({
        kind: 'code' as const,
        ...(language === undefined ? {} : { language }),
        lines: Object.freeze(body),
        // An unterminated fence is reported, not hidden: the model may still be
        // streaming, and a silent swallow would look like lost output.
        unterminated: !terminated,
      }))
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push(Object.freeze({
        kind: 'heading' as const,
        level: (heading[1] ?? '#').length,
        text: (heading[2] ?? '').trim(),
      }))
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push(Object.freeze({ kind: 'rule' as const }))
      index += 1
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      const body: string[] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '')
        if (match === null) break
        body.push(match[1] ?? '')
        index += 1
      }
      blocks.push(Object.freeze({ kind: 'quote' as const, lines: Object.freeze(body) }))
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const items: { depth: number, marker: string, text: string }[] = []
      while (index < lines.length) {
        const raw = lines[index] ?? ''
        const bullet = BULLET.exec(raw)
        const ordered = bullet === null ? ORDERED.exec(raw) : null
        if (bullet === null && ordered === null) break
        const indent = (bullet?.[1] ?? ordered?.[1] ?? '').length
        items.push({
          depth: Math.min(4, Math.floor(indent / 2)),
          marker: bullet === null ? `${ordered?.[2] ?? '1'}.` : '•',
          text: (bullet?.[3] ?? ordered?.[3] ?? '').trim(),
        })
        index += 1
      }
      blocks.push(Object.freeze({ kind: 'list' as const, items: Object.freeze(items) }))
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const raw = lines[index] ?? ''
      if (
        raw.trim() === ''
        || FENCE.test(raw) || HEADING.test(raw) || RULE.test(raw)
        || QUOTE.test(raw) || BULLET.test(raw) || ORDERED.test(raw)
      ) break
      paragraph.push(raw.trim())
      index += 1
    }
    blocks.push(Object.freeze({ kind: 'paragraph' as const, text: paragraph.join(' ') }))
  }

  return Object.freeze(blocks)
}

export interface InlineSpan {
  readonly code?: true
  readonly emphasis?: true
  readonly strong?: true
  readonly text: string
}

const INLINE = /(`+)([^`]*?)\1|(\*\*|__)(.+?)\3|(\*|_)(.+?)\5/gsu

/**
 * Split inline markup into styled spans.
 *
 * Unmatched delimiters stay literal — a lone asterisk is far more often
 * punctuation than the start of emphasis the model never closed.
 */
export function parseInline(text: string, maxSpans = DEFAULT_MAX_SPANS): readonly InlineSpan[] {
  const spans: InlineSpan[] = []
  let cursor = 0
  INLINE.lastIndex = 0
  let match = INLINE.exec(text)
  while (match !== null && spans.length < maxSpans) {
    if (match.index > cursor) {
      spans.push(Object.freeze({ text: text.slice(cursor, match.index) }))
    }
    if (match[2] !== undefined) spans.push(Object.freeze({ code: true as const, text: match[2] }))
    else if (match[4] !== undefined) spans.push(Object.freeze({ strong: true as const, text: match[4] }))
    else if (match[6] !== undefined) spans.push(Object.freeze({ emphasis: true as const, text: match[6] }))
    cursor = match.index + match[0].length
    match = INLINE.exec(text)
  }
  if (cursor < text.length) spans.push(Object.freeze({ text: text.slice(cursor) }))
  return Object.freeze(spans.length === 0 ? [Object.freeze({ text })] : spans)
}

/**
 * Markup-free text for the clipboard projection.
 *
 * The OSC 52 copy path must carry no markup and no escapes: whatever lands on
 * the clipboard is pasted somewhere this renderer does not control.
 */
export function markdownPlainText(blocks: readonly MarkdownBlock[]): string {
  const out: string[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case 'code':
        out.push(...block.lines)
        break
      case 'heading':
        out.push(parseInline(block.text).map(span => span.text).join(''))
        break
      case 'list':
        for (const item of block.items) {
          out.push(`${'  '.repeat(item.depth)}${item.marker} `
            + parseInline(item.text).map(span => span.text).join(''))
        }
        break
      case 'paragraph':
        out.push(parseInline(block.text).map(span => span.text).join(''))
        break
      case 'quote':
        out.push(...block.lines)
        break
      case 'rule':
        out.push('---')
        break
    }
  }
  return out.join('\n')
}
