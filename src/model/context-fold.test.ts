import { describe, expect, it } from 'vitest'

import { foldInjectedContent, foldSummary } from './context-fold'

const long = ['# Project rules', '', 'one', 'two', 'three', 'four'].join('\n')

describe('foldInjectedContent (M6)', () => {
  // The transcript must still contain what the model was given; folding is a
  // presentation choice, so the content is reachable, not discarded.
  it('folds a long injection to its first meaningful line', () => {
    const folded = foldInjectedContent(long)
    expect(folded.folded).toBe(true)
    expect(folded.lines).toEqual(['# Project rules'])
    expect(folded.hiddenLines).toBe(5)
  })

  it('returns everything when expanded', () => {
    const expanded = foldInjectedContent(long, true)
    expect(expanded.folded).toBe(false)
    expect(expanded.hiddenLines).toBe(0)
    expect(expanded.lines).toHaveLength(6)
  })

  // A fold affordance on a two-line notice is noise, not help.
  it('leaves short injections alone', () => {
    const short = foldInjectedContent('one\ntwo')
    expect(short.folded).toBe(false)
    expect(short.lines).toEqual(['one', 'two'])
  })

  it('respects the threshold boundary exactly', () => {
    expect(foldInjectedContent('a\nb\nc', false, 3).folded).toBe(false)
    expect(foldInjectedContent('a\nb\nc\nd', false, 3).folded).toBe(true)
  })

  // A leading blank line would otherwise become the entire summary.
  it('skips blank lines when choosing the visible line', () => {
    const folded = foldInjectedContent('\n\n   \nActual heading\nrest\nmore\n')
    expect(folded.lines).toEqual(['Actual heading'])
  })

  it('handles content that is entirely blank', () => {
    const folded = foldInjectedContent('\n\n\n\n')
    expect(folded.lines).toEqual([''])
    expect(folded.folded).toBe(true)
  })

  it('rejects an invalid threshold', () => {
    expect(() => foldInjectedContent('a', false, 0))
      .toThrow('threshold must be a positive safe integer')
  })
})

describe('foldSummary (M6)', () => {
  // A fold the user cannot discover how to open is just truncation.
  it('names the count and the key', () => {
    expect(foldSummary(41)).toBe('+ 41 lines · ^E expand')
    expect(foldSummary(1)).toBe('+ 1 line · ^E expand')
  })
})
