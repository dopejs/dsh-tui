import { describe, expect, it } from 'vitest'

import { projectTranscriptPlainText } from '../model/transcript-viewport-controller'
import { renderInkFrame } from './ink-renderer'

const ESC = String.fromCharCode(27)

const MARKDOWN = [
  'Here is the plan.',
  '',
  '## Steps',
  '- run `pnpm check`',
  '- fix **two** issues',
  '',
  '```ts',
  'const a = 1',
  '```',
].join('\n')

describe('markdown and the clipboard projection (M6.3)', () => {
  // Whatever OSC 52 puts on the clipboard is pasted somewhere this renderer
  // does not control, so it must carry no terminal escapes.
  it('copies source text carrying no escape sequences', () => {
    const rows = [{ content: MARKDOWN, id: 'a', kind: 'assistant' as const }]
    const copied = projectTranscriptPlainText(rows).text
    expect(copied.includes(ESC)).toBe(false)
  })

  // The copy keeps the Markdown source rather than the rendered form: pasting
  // into an issue or a document should keep the structure the model wrote.
  it('preserves the markup rather than flattening it', () => {
    const rows = [{ content: MARKDOWN, id: 'a', kind: 'assistant' as const }]
    const copied = projectTranscriptPlainText(rows).text
    expect(copied).toContain('## Steps')
    expect(copied).toContain('`pnpm check`')
  })

  it('renders the same content without emitting escapes into a non-TTY frame', () => {
    const output = renderInkFrame(
      {
        rows: [{ content: MARKDOWN, id: 'a', kind: 'assistant' }],
        sessionId: 'session',
        status: 'idle',
        totalRows: 1,
      },
      80,
    )
    expect(output.includes(ESC)).toBe(false)
    expect(output).toContain('Here is the plan.')
    expect(output).toContain('const a = 1')
  })
})
