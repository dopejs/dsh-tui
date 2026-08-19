import { describe, expect, it } from 'vitest'

import { formatElapsed, tokensPerSecond, workingStatus } from './working-status'

describe('formatElapsed (M6.6)', () => {
  it.each([
    [0, '0.0s'],
    [1_400, '1.4s'],
    [9_900, '9.9s'],
    [12_000, '12s'],
    [59_400, '59s'],
    [185_000, '3m 05s'],
  ])('formats %ims as %s', (milliseconds, expected) => {
    expect(formatElapsed(milliseconds)).toBe(expected)
  })

  // The guard must not emit a shape the normal path never produces.
  it('clamps an impossible duration into the normal format', () => {
    expect(formatElapsed(-5)).toBe('0.0s')
    expect(formatElapsed(Number.NaN)).toBe('0.0s')
  })
})

describe('tokensPerSecond (M6.6)', () => {
  it('computes a rate over a meaningful window', () => {
    expect(tokensPerSecond(300, 10_000)).toBe(30)
    expect(tokensPerSecond(45, 3_000)).toBe(15)
  })

  // A rate over a sub-second window is noise, and a rate with no tokens is a
  // throughput claim nothing has observed.
  it('withholds a rate it cannot compute honestly', () => {
    expect(tokensPerSecond(100, 500)).toBeUndefined()
    expect(tokensPerSecond(0, 10_000)).toBeUndefined()
    expect(tokensPerSecond(undefined, 10_000)).toBeUndefined()
  })
})

describe('workingStatus (M6.6)', () => {
  // An idle agent has no work to report; the caller renders no row at all.
  it('reports nothing while idle', () => {
    expect(workingStatus({ elapsedMs: 5_000, running: false }).segments).toEqual([])
  })

  // Escape, not Ctrl-C: interrupting is what a person reaches for while the
  // agent works, and Ctrl-C is the key that ends programs.
  it('always offers the elapsed time and the cancel key', () => {
    expect(workingStatus({ elapsedMs: 2_500, running: true }).segments)
      .toEqual(['2.5s', 'Esc cancel'])
  })

  it('adds the rate and effort when the runtime reports them', () => {
    expect(workingStatus({
      elapsedMs: 10_000,
      outputTokens: 200,
      reasoningEffort: 'medium',
      running: true,
    }).segments).toEqual(['10s', '20 tok/s', 'medium', 'Esc cancel'])
  })

  // Absent facts are omitted, never zeroed.
  it('omits what the runtime does not report', () => {
    const segments = workingStatus({ elapsedMs: 10_000, running: true }).segments
    expect(segments).not.toContain('0 tok/s')
    expect(segments.some(segment => segment.includes('tok/s'))).toBe(false)
  })
})
