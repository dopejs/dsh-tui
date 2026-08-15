import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'

import {
  apply,
  formatHelp,
  parseStartupArguments,
  TUI_STARTUP_SERVICE,
} from './startup'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

function runProvider(args: readonly string[]) {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const stream = { write: (chunk: string) => { output += chunk; return true } }
  internals.stdout = stream
  internals.stderr = stream
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  apply(ctx)
  return {
    dispose: () => ctx.fiber.dispose(),
    exits,
    output: () => output,
    values: () => ctx.get(TUI_STARTUP_SERVICE),
  }
}

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

describe('tui command-line provider', () => {
  it('provides immutable fresh and resume startup values', async () => {
    const fresh = runProvider([])
    expect(fresh.values()).toEqual({})
    expect(fresh.exits).toEqual([])
    await fresh.dispose()

    const resumed = runProvider(['--resume', 'session-1'])
    expect(resumed.values()).toEqual({ resumeSessionId: 'session-1' })
    expect(resumed.exits).toEqual([])
    await resumed.dispose()
  })

  it('prints app-owned help without publishing startup values', async () => {
    const mounted = runProvider(['--help'])
    expect(mounted.output()).toContain('dsh --profile tui')
    expect(mounted.values()).toBeUndefined()
    expect(mounted.exits).toEqual([0])
    await mounted.dispose()
  })
})
