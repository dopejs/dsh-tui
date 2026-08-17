import { describe, expect, it } from 'vitest'

import { compactCount, contextGauge, describeSources } from './status-bar'

describe('contextGauge (M6)', () => {
  it('renders a bar exactly as wide as asked', () => {
    for (const width of [1, 5, 10, 40]) {
      expect(contextGauge(500, 1_000, width)?.bar).toHaveLength(width)
    }
  })

  it('reports whole percent', () => {
    expect(contextGauge(0, 1_000)?.percent).toBe(0)
    expect(contextGauge(250, 1_000)?.percent).toBe(25)
    expect(contextGauge(1_000, 1_000)?.percent).toBe(100)
  })

  // Rounding a real usage down to an empty bar hides exactly the thing the
  // gauge exists to show.
  it('shows at least one cell once anything is consumed', () => {
    const gauge = contextGauge(1, 1_000_000)
    expect(gauge?.percent).toBe(0)
    expect(gauge?.bar.startsWith('█')).toBe(true)
  })

  // And a nearly-full window must not read as full.
  it('keeps at least one cell empty below the window', () => {
    const gauge = contextGauge(999_999, 1_000_000)
    expect(gauge?.bar.endsWith('░')).toBe(true)
    expect(gauge?.bar).not.toBe('█'.repeat(10))
  })

  it('fills completely only at or beyond the window', () => {
    expect(contextGauge(1_000, 1_000)?.bar).toBe('█'.repeat(10))
    expect(contextGauge(5_000, 1_000)?.bar).toBe('█'.repeat(10))
    expect(contextGauge(5_000, 1_000)?.percent).toBe(100)
  })

  it('marks pressure at four fifths of the window', () => {
    expect(contextGauge(799, 1_000)?.pressured).toBe(false)
    expect(contextGauge(800, 1_000)?.pressured).toBe(true)
  })

  // An unknown window is not a full one; the gauge is simply absent.
  it('yields no gauge without a usable capacity', () => {
    expect(contextGauge(100, undefined)).toBeUndefined()
    expect(contextGauge(100, 0)).toBeUndefined()
    expect(contextGauge(100, -1)).toBeUndefined()
    expect(contextGauge(100, Number.NaN)).toBeUndefined()
  })

  it('treats impossible usage as zero rather than throwing', () => {
    expect(contextGauge(-5, 1_000)?.percent).toBe(0)
    expect(contextGauge(Number.NaN, 1_000)?.percent).toBe(0)
  })

  it('rejects an invalid width', () => {
    expect(() => contextGauge(1, 10, 0)).toThrow('width must be a positive safe integer')
    expect(() => contextGauge(1, 10, 1.5)).toThrow('width must be a positive safe integer')
  })
})

describe('compactCount (M6)', () => {
  it.each([
    [0, '0'],
    [-1, '0'],
    [999, '999'],
    [1_000, '1.0k'],
    [1_234, '1.2k'],
    [999_999, '1000.0k'],
    [1_234_567, '1.2M'],
  ])('formats %i as %s', (value, expected) => {
    expect(compactCount(value)).toBe(expected)
  })
})

describe('describeSources (M6)', () => {
  it('pluralizes and joins present sources', () => {
    expect(describeSources([
      { count: 1, label: 'CLAUDE.md' },
      { count: 2, label: 'MCP server' },
    ])).toBe('1 CLAUDE.md · 2 MCP servers')
  })

  // A zero is not information about what is loaded.
  it('omits sources with nothing loaded', () => {
    expect(describeSources([
      { count: 0, label: 'CLAUDE.md' },
      { count: 3, label: 'skill' },
    ])).toBe('3 skills')
    expect(describeSources([{ count: 0, label: 'MCP server' }])).toBeUndefined()
    expect(describeSources([])).toBeUndefined()
  })
})
