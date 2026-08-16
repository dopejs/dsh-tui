import { describe, expect, it, vi } from 'vitest'

import { writeOsc52Clipboard } from './clipboard'

describe('writeOsc52Clipboard (M1.2)', () => {
  it('writes bounded UTF-8 text as an OSC 52 clipboard request', () => {
    const write = vi.fn(() => true)
    expect(writeOsc52Clipboard({ isTTY: true, write }, '寬 text')).toBe('sent')
    expect(write).toHaveBeenCalledWith(`\u001B]52;c;${Buffer.from('寬 text').toString('base64')}\u0007`)
  })

  it('fails closed for redirected output or an oversized payload', () => {
    const write = vi.fn(() => true)
    expect(writeOsc52Clipboard({ isTTY: false, write }, 'text')).toBe('unavailable')
    expect(writeOsc52Clipboard({ isTTY: true, write }, '寬', 2)).toBe('too-large')
    expect(write).not.toHaveBeenCalled()
    expect(() => writeOsc52Clipboard({ isTTY: true, write }, 'x', 0)).toThrow('maximumBytes')
  })

  it('contains synchronous terminal write failures', () => {
    const write = vi.fn((): boolean => { throw new Error('output closed') })
    expect(writeOsc52Clipboard({ isTTY: true, write }, 'text')).toBe('unavailable')
  })
})
