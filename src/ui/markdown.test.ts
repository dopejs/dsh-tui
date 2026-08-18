import { describe, expect, it } from 'vitest'

import { markdownPlainText, parseInline, parseMarkdown } from './markdown'

describe('parseMarkdown (M6.3)', () => {
  it('reads headings, paragraphs, lists, quotes, and rules', () => {
    const blocks = parseMarkdown([
      '# Title',
      '',
      'A paragraph that',
      'wraps across lines.',
      '',
      '- one',
      '- two',
      '',
      '> quoted',
      '',
      '---',
    ].join('\n'))
    expect(blocks.map(block => block.kind))
      .toEqual(['heading', 'paragraph', 'list', 'quote', 'rule'])
    expect(blocks[1]).toMatchObject({ text: 'A paragraph that wraps across lines.' })
  })

  it('reads a fenced code block with its language', () => {
    const [block] = parseMarkdown('```ts\nconst a = 1\n```')
    expect(block).toMatchObject({
      kind: 'code',
      language: 'ts',
      lines: ['const a = 1'],
      unterminated: false,
    })
  })

  // A model that is still streaming has an open fence; swallowing the rest
  // silently would look like lost output.
  it('reports an unterminated fence rather than hiding it', () => {
    const [block] = parseMarkdown('```\nstill going')
    expect(block).toMatchObject({ kind: 'code', lines: ['still going'], unterminated: true })
  })

  it('does not let a tilde fence close a backtick fence', () => {
    const [block] = parseMarkdown('```\ncode\n~~~\nmore\n```')
    expect(block).toMatchObject({ lines: ['code', '~~~', 'more'], unterminated: false })
  })

  it('nests list items by indentation', () => {
    const [block] = parseMarkdown('- top\n  - nested\n1. ordered')
    expect(block).toMatchObject({ kind: 'list' })
    expect(block?.kind === 'list' ? block.items : []).toEqual([
      { depth: 0, marker: '•', text: 'top' },
      { depth: 1, marker: '•', text: 'nested' },
      { depth: 0, marker: '1.', text: 'ordered' },
    ])
  })

  it('never throws on hostile input', () => {
    for (const source of ['', '#', '```', '>'.repeat(500), '- '.repeat(500), '*'.repeat(1_000)]) {
      expect(() => parseMarkdown(source)).not.toThrow()
    }
  })

  it('bounds blocks and code lines', () => {
    const many = Array.from({ length: 50 }, (_, index) => `# h${String(index)}`).join('\n\n')
    expect(parseMarkdown(many, { maxBlocks: 10 })).toHaveLength(10)

    const code = `\`\`\`\n${Array.from({ length: 50 }, () => 'x').join('\n')}\n\`\`\``
    const [block] = parseMarkdown(code, { maxCodeLines: 5 })
    expect(block?.kind === 'code' ? block.lines : []).toHaveLength(5)
  })

  it('rejects invalid bounds', () => {
    expect(() => parseMarkdown('a', { maxBlocks: 0 }))
      .toThrow('maxBlocks must be a positive safe integer')
  })
})

describe('parseInline (M6.3)', () => {
  it('splits code, strong, and emphasis', () => {
    expect(parseInline('run `npm test` then **stop** or _wait_')).toEqual([
      { text: 'run ' },
      { code: true, text: 'npm test' },
      { text: ' then ' },
      { strong: true, text: 'stop' },
      { text: ' or ' },
      { emphasis: true, text: 'wait' },
    ])
  })

  // A lone asterisk is punctuation far more often than unclosed emphasis.
  it('leaves unmatched delimiters literal', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }])
    expect(parseInline('a `unclosed')).toEqual([{ text: 'a `unclosed' }])
  })

  it('always returns at least one span', () => {
    expect(parseInline('')).toEqual([{ text: '' }])
  })
})

describe('markdownPlainText (M6.3)', () => {
  // Whatever lands on the clipboard is pasted somewhere this renderer does not
  // control, so it carries no markup and no escapes.
  it('strips markup and emits no escapes', () => {
    const text = markdownPlainText(parseMarkdown([
      '# Title',
      'run `npm test` and **stop**',
      '- item one',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n')))
    expect(text).toBe('Title\nrun npm test and stop\n• item one\nconst a = 1')
    expect(text.includes(String.fromCharCode(27))).toBe(false)
    expect(text).not.toContain('`')
    expect(text).not.toContain('**')
  })
})
