import { describe, expect, it } from 'vitest'

import { formatHelp, parseStartupArguments } from './startup'

describe('parseStartupArguments', () => {
  it('parses help and resume', () => {
    expect(parseStartupArguments(['--resume', 'session-1'])).toEqual({
      help: false,
      resumeSessionId: 'session-1',
    })
    expect(parseStartupArguments(['-h'])).toEqual({ help: true })
  })

  it('rejects incomplete and unknown arguments', () => {
    expect(() => parseStartupArguments(['--resume'])).toThrow(
      '--resume requires a session id',
    )
    expect(() => parseStartupArguments(['--unknown'])).toThrow(
      'Unknown argument: --unknown',
    )
  })
})

describe('formatHelp', () => {
  it('documents the supported startup surface', () => {
    expect(formatHelp()).toContain('--resume <session-id>')
  })
})
