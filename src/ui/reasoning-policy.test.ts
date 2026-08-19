import { describe, expect, it } from 'vitest'

import { createTranscriptState, reduceTranscriptBatch } from '../model/transcript-reducer'
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
  // No chord is named: the line is clickable, and offering both a click and a
  // key to press makes the interface explain two ways to do one thing.
  it('folds reasoning behind a discoverable affordance in the transcript', () => {
    const output = renderInkFrame(model, 70)
    expect(output).toContain('The answer is 42.')
    expect(output).toContain('reasoning hidden')
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

  // The streaming path split reasoning from the answer correctly and the
  // finished-message path glued them back together, so every guarantee above
  // held until the turn ended and then quietly stopped holding. This asserts
  // the policy where it actually broke.
  it('keeps the split when the finished message replaces the streamed row', () => {
    const state = reduceTranscriptBatch(createTranscriptState({ maxRowChars: 500 }), [
      {
        data: {
          message: {
            content: [
              { text: 'Weigh the options carefully.', type: 'reasoning' },
              { text: 'The answer is 42.', type: 'text' },
            ],
            id: 'assistant-final',
            role: 'assistant',
            source: { kind: 'model', model: 'fixture', provider: 'fixture' },
          },
          step: 0,
          turn: 0,
        },
        seq: 0,
        time: 0,
        type: 'assistant/message',
      },
    ] as never)

    expect(state.rows).toHaveLength(1)
    const finished = state.rows[0]
    if (finished === undefined) throw new Error('no row')
    expect(finished.content).toBe('The answer is 42.')
    expect(finished.reasoning).toBe('Weigh the options carefully.')
    expect(finished.content).not.toContain('Reasoning:')

    // And the surfaces built from it agree, exactly as they do while streaming.
    expect(renderInkFrame({
      rows: state.rows,
      sessionId: 'session',
      status: 'idle',
      totalRows: 1,
    }, 70)).not.toContain('Weigh the options')
    expect(projectTranscriptPlainText(state.rows).text).not.toContain('Weigh the options')
  })
})
