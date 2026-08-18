import { describe, expect, it } from 'vitest'

import { projectTranscriptPlainText } from '../model/transcript-viewport-controller'
import { assistantText } from '../runtime/output-contract'
import { renderInkFrame } from './ink-renderer'

const ROW = {
  content: 'The answer is 42.',
  id: 'a',
  kind: 'assistant' as const,
  reasoning: 'Weigh the options carefully.',
}

const model = {
  rows: [ROW],
  sessionId: 'session',
  status: 'idle' as const,
  totalRows: 1,
}

describe('reasoning policy (M6.7)', () => {
  // A human may want the scratch work; it must not be mistaken for the answer.
  it('folds reasoning behind a discoverable key in the transcript', () => {
    const output = renderInkFrame(model, 70)
    expect(output).toContain('The answer is 42.')
    expect(output).toContain('reasoning hidden')
    expect(output).toContain('^E show')
    expect(output).not.toContain('Weigh the options')
  })

  it('shows it once expanded', () => {
    const output = renderInkFrame(model, 70, new Set(['a']))
    expect(output).toContain('Weigh the options carefully.')
    expect(output).not.toContain('reasoning hidden')
  })

  // The clipboard carries the answer. Pasting a model's deliberation into an
  // issue as if it were the conclusion is the failure this prevents.
  it('leaves reasoning out of the clipboard projection', () => {
    const copied = projectTranscriptPlainText([ROW]).text
    expect(copied).toContain('The answer is 42.')
    expect(copied).not.toContain('Weigh the options')
  })

  // A pipeline consumer must never act on scratch work.
  it('leaves reasoning out of the --print contract', () => {
    expect(assistantText([
      { text: 'Weigh the options carefully.', type: 'reasoning' },
      { text: 'The answer is 42.', type: 'text' },
    ] as never)).toBe('The answer is 42.')
  })

  // The three surfaces must not disagree about what the answer is.
  it('agrees across transcript, clipboard, and print', () => {
    const rendered = renderInkFrame(model, 70)
    const copied = projectTranscriptPlainText([ROW]).text
    const printed = assistantText([
      { text: ROW.reasoning, type: 'reasoning' },
      { text: ROW.content, type: 'text' },
    ] as never)
    for (const surface of [rendered, copied, printed]) {
      expect(surface).toContain('The answer is 42.')
      expect(surface).not.toContain('Weigh the options')
    }
  })
})
