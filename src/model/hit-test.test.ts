import { describe, expect, it } from 'vitest'

import { hitTestTranscript } from './hit-test'
import type { TranscriptRow } from './view-model'

const rows: TranscriptRow[] = [
  { content: 'hello', id: 'user', kind: 'user' },
  { content: 'an answer', id: 'answer', kind: 'assistant', reasoning: 'first\nsecond' },
  { content: 'later', id: 'later', kind: 'user' },
]

describe('hitTestTranscript (M7.8)', () => {
  // The first row has no separator above it; every later one does.
  it('finds the row drawn at a line', () => {
    expect(hitTestTranscript(0, { firstLine: 0, rows })?.rowId).toBe('user')
    // blank, fold, content
    expect(hitTestTranscript(2, { firstLine: 0, rows })?.rowId).toBe('answer')
    expect(hitTestTranscript(3, { firstLine: 0, rows })?.rowId).toBe('answer')
    expect(hitTestTranscript(5, { firstLine: 0, rows })?.rowId).toBe('later')
  })

  // Clicking the fold is how reasoning is opened without knowing a chord.
  it('reports when the line is the folded-reasoning affordance', () => {
    expect(hitTestTranscript(2, { firstLine: 0, rows })?.onReasoningFold).toBe(true)
    expect(hitTestTranscript(3, { firstLine: 0, rows })?.onReasoningFold).toBe(false)
  })

  // An expanded row draws every line of its reasoning, so the rows below it
  // move down by that much: measuring them as one line would send a click to
  // the wrong row for the rest of the screen.
  it('accounts for reasoning drawn in full', () => {
    const expandedRowIds = new Set(['answer'])
    expect(hitTestTranscript(2, { expandedRowIds, firstLine: 0, rows })?.rowId).toBe('answer')
    expect(hitTestTranscript(3, { expandedRowIds, firstLine: 0, rows })?.rowId).toBe('answer')
    expect(hitTestTranscript(4, { expandedRowIds, firstLine: 0, rows })?.rowId).toBe('answer')
    expect(hitTestTranscript(6, { expandedRowIds, firstLine: 0, rows })?.rowId).toBe('later')
    // Expanded, there is no fold affordance left to aim at, so the reasoning
    // itself is what collapses it -- every line of it.
    expect(hitTestTranscript(2, { expandedRowIds, firstLine: 0, rows })?.onReasoningFold)
      .toBe(true)
    expect(hitTestTranscript(3, { expandedRowIds, firstLine: 0, rows })?.onReasoningFold)
      .toBe(true)
    expect(hitTestTranscript(4, { expandedRowIds, firstLine: 0, rows })?.onReasoningFold)
      .toBe(false)
  })

  it('offsets by where the transcript starts on screen', () => {
    expect(hitTestTranscript(10, { firstLine: 10, rows })?.rowId).toBe('user')
    expect(hitTestTranscript(0, { firstLine: 10, rows })).toBeUndefined()
  })

  // A click on empty space is not a click on the thing above it.
  it('reports nothing for a line no row occupies', () => {
    expect(hitTestTranscript(99, { firstLine: 0, rows })).toBeUndefined()
    expect(hitTestTranscript(0, { firstLine: 0, rows: [] })).toBeUndefined()
  })
})
