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
  it('parses help, model, and resume', () => {
    expect(parseStartupArguments(['--resume', 'session-1'])).toEqual({
      help: false,
      print: false,
      resumeSessionId: 'session-1',
    })
    expect(parseStartupArguments(['-h'])).toEqual({ help: true, print: false })
    expect(parseStartupArguments(['--model', 'provider/model'])).toEqual({
      help: false,
      model: 'provider/model',
      print: false,
    })
  })

  it('parses the non-interactive run surface', () => {
    expect(parseStartupArguments(['--print'])).toEqual({ help: false, print: true })
    expect(parseStartupArguments(['-p', 'explain this'])).toEqual({
      help: false,
      print: true,
      prompt: 'explain this',
    })
    expect(parseStartupArguments(['--print', '--output-format', 'stream-json'])).toEqual({
      help: false,
      outputFormat: 'stream-json',
      print: true,
    })
  })

  // The format describes --print output; accepting it otherwise would promise
  // a contract the interactive runtime never emits.
  it('refuses print-only options without --print', () => {
    expect(() => parseStartupArguments(['--output-format', 'json']))
      .toThrow('--output-format requires --print')
    expect(() => parseStartupArguments(['explain this']))
      .toThrow('a prompt argument requires --print')
  })

  it('rejects an unsupported output format instead of falling back', () => {
    expect(() => parseStartupArguments(['--print', '--output-format', 'yaml']))
      .toThrow('--output-format must be one of json, stream-json, text')
    expect(() => parseStartupArguments(['--print', '--output-format']))
      .toThrow('--output-format must be one of json, stream-json, text')
    expect(() => parseStartupArguments([
      '--print', '--output-format', 'json', '--output-format', 'text',
    ])).toThrow('--output-format may only be specified once')
  })

  it('rejects incomplete and unknown arguments', () => {
    expect(() => parseStartupArguments(['--resume'])).toThrow(
      '--resume requires a session id',
    )
    expect(() => parseStartupArguments(['--unknown'])).toThrow(
      'Unknown argument: --unknown',
    )
    expect(() => parseStartupArguments([
      '--model', 'provider/model', '--resume', 'session-1',
    ])).toThrow('--model cannot be combined with --resume')
  })
})

describe('formatHelp', () => {
  it('documents the supported startup surface', () => {
    expect(formatHelp()).toContain('--resume <session-id>')
    expect(formatHelp()).toContain('--model <provider/model>')
    expect(formatHelp()).toContain('--print')
    expect(formatHelp()).toContain('--output-format <fmt>')
  })
})

describe('tui command-line provider', () => {
  it('provides immutable fresh and resume startup values', async () => {
    const fresh = runProvider([])
    expect(fresh.values()).toEqual({ print: false })
    expect(fresh.exits).toEqual([])
    await fresh.dispose()

    const resumed = runProvider(['--resume', 'session-1'])
    expect(resumed.values()).toEqual({ print: false, resumeSessionId: 'session-1' })
    expect(resumed.exits).toEqual([])
    await resumed.dispose()

    const selected = runProvider(['--model', 'provider/model'])
    expect(selected.values()).toEqual({ model: 'provider/model', print: false })
    await selected.dispose()
  })

  it('rejects model override when resuming a persisted session', async () => {
    const mounted = runProvider(['--model', 'provider/model', '--resume', 'session-1'])
    expect(mounted.values()).toBeUndefined()
    expect(mounted.exits).toEqual([1])
    expect(mounted.output()).toContain('--model cannot be combined with --resume')
    await mounted.dispose()
  })

  it('prints app-owned help without publishing startup values', async () => {
    const mounted = runProvider(['--help'])
    expect(mounted.output()).toContain('dsh --profile tui')
    expect(mounted.values()).toBeUndefined()
    expect(mounted.exits).toEqual([0])
    await mounted.dispose()
  })
})
