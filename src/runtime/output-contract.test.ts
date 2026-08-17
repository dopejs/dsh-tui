import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import {
  OUTPUT_ENVELOPE_VERSION,
  assistantText,
  createOutputEncoder,
  envelopeFor,
  exitCodeFor,
  isOutputFormat,
  type OutputFormat,
} from './output-contract'

const SESSION = 'session-1'

function assistant(seq: number, text: string, extra: unknown[] = []): SessionEvent {
  return {
    data: {
      message: {
        content: [...extra, { text, type: 'text' }],
        id: 'message',
        role: 'assistant',
        source: { kind: 'model', model: 'm', provider: 'p' },
      },
      step: 0,
      turn: 0,
    },
    seq,
    time: seq,
    type: 'assistant/message',
  } as unknown as SessionEvent
}

function toolCall(seq: number, name: string, callId = 'call-1'): SessionEvent {
  return {
    data: { callId, name },
    seq,
    time: seq,
    type: 'tool/call',
  } as unknown as SessionEvent
}

function toolResult(seq: number, isError = false, callId = 'call-1'): SessionEvent {
  return {
    data: { callId, isError },
    seq,
    time: seq,
    type: 'tool/result',
  } as unknown as SessionEvent
}

function run(format: OutputFormat, events: readonly SessionEvent[]): string {
  const encoder = createOutputEncoder(format)
  let output = ''
  for (const event of events) output += encoder.event(event, SESSION)
  output += encoder.end({ reason: 'completed', sessionId: SESSION })
  return output
}

describe('output contract (M5.1)', () => {
  it('accepts exactly the documented formats', () => {
    expect(isOutputFormat('text')).toBe(true)
    expect(isOutputFormat('json')).toBe(true)
    expect(isOutputFormat('stream-json')).toBe(true)
    expect(isOutputFormat('yaml')).toBe(false)
    expect(isOutputFormat('')).toBe(false)
  })

  // Reasoning is the model's scratch work, not its answer; a piped consumer
  // that acted on it would act on something the model did not commit to.
  it('joins text blocks and excludes reasoning', () => {
    expect(assistantText([
      { text: 'Hello ', type: 'text' },
      { text: 'ignore me', type: 'reasoning' },
      { text: 'world', type: 'text' },
    ] as never)).toBe('Hello world')
  })

  it('bounds a pathologically large answer', () => {
    const text = assistantText([{ text: 'x'.repeat(2_000_000), type: 'text' }] as never)
    expect(text).toHaveLength(1_000_000)
    expect(text.endsWith('…')).toBe(true)
  })

  it('skips an unknown event type instead of guessing at it', () => {
    const event = { data: {}, seq: 1, time: 1, type: 'future/thing' } as unknown as SessionEvent
    expect(envelopeFor(event, SESSION)).toBeUndefined()
  })

  it('skips a malformed event rather than emitting a partial envelope', () => {
    expect(envelopeFor(
      { data: { message: 'nope' }, seq: 1, time: 1, type: 'assistant/message' } as never,
      SESSION,
    )).toBeUndefined()
    expect(envelopeFor(
      { data: {}, seq: 1, time: 1, type: 'tool/call' } as never,
      SESSION,
    )).toBeUndefined()
  })

  it('stamps every envelope with the schema version', () => {
    const envelope = envelopeFor(assistant(1, 'hi'), SESSION)
    expect(envelope).toMatchObject({ v: OUTPUT_ENVELOPE_VERSION })
  })

  it('emits only the answer in text format', () => {
    expect(run('text', [
      assistant(1, 'first'),
      toolCall(2, 'read_file'),
      toolResult(3),
      assistant(4, 'second'),
    ])).toMatchInlineSnapshot(`
      "first
      second
      "
    `)
  })

  // A clean run pipes verbatim, so `dsh --print | wc -l` counts answer lines.
  it('adds no trailer to a clean text run but names a failure', () => {
    const encoder = createOutputEncoder('text')
    expect(encoder.end({ reason: 'completed', sessionId: SESSION })).toBe('')
    expect(createOutputEncoder('text').end({
      message: 'model unavailable',
      reason: 'failed',
      sessionId: SESSION,
    })).toBe('failed: model unavailable\n')
  })

  it('emits one envelope per line in stream-json, in event order', () => {
    const lines = run('stream-json', [
      assistant(1, 'first'),
      toolCall(2, 'read_file'),
      toolResult(3, true),
    ]).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

    expect(lines.map(line => line.type)).toEqual([
      'assistant',
      'tool-call',
      'tool-result',
      'result',
    ])
    expect(lines.map(line => line.seq)).toEqual([1, 2, 3, undefined])
    expect(lines[2]).toMatchObject({ callId: 'call-1', failed: true })
    expect(lines[3]).toMatchObject({ reason: 'completed', sessionId: SESSION })
  })

  it('emits one document in json format with the result last', () => {
    const document = JSON.parse(run('json', [assistant(1, 'hi'), toolCall(2, 'bash')])) as {
      envelopes: { type: string }[]
      v: number
    }
    expect(document.v).toBe(OUTPUT_ENVELOPE_VERSION)
    expect(document.envelopes.map(envelope => envelope.type))
      .toEqual(['assistant', 'tool-call', 'result'])
  })

  it('writes nothing before the end in json format', () => {
    const encoder = createOutputEncoder('json')
    expect(encoder.event(assistant(1, 'hi'), SESSION)).toBe('')
    expect(encoder.end({ reason: 'completed', sessionId: SESSION })).not.toBe('')
  })

  it('preserves event order across every format', () => {
    const events = [assistant(1, 'a'), assistant(2, 'b'), assistant(3, 'c')]
    expect(run('text', events)).toBe('a\nb\nc\n')

    const streamed = run('stream-json', events).trimEnd().split('\n')
      .map(line => JSON.parse(line) as { text?: string })
    expect(streamed.map(line => line.text)).toEqual(['a', 'b', 'c', undefined])

    const document = JSON.parse(run('json', events)) as { envelopes: { text?: string }[] }
    expect(document.envelopes.map(envelope => envelope.text))
      .toEqual(['a', 'b', 'c', undefined])
  })

  it.each([
    ['completed', 0],
    ['failed', 1],
    ['interaction-required', 2],
    ['cancelled', 130],
  ] as const)('maps %s to exit code %i', (reason, code) => {
    expect(exitCodeFor(reason)).toBe(code)
  })

  // A run that needs a human is not a crash: retrying it unchanged hits the
  // same wall, so it gets its own code rather than sharing the failure one.
  it('separates needing a human from failing', () => {
    expect(exitCodeFor('interaction-required')).not.toBe(exitCodeFor('failed'))
    expect(exitCodeFor('interaction-required')).not.toBe(exitCodeFor('completed'))
  })

  it('names the reason in every terminal envelope', () => {
    for (const reason of ['completed', 'failed', 'cancelled', 'interaction-required'] as const) {
      const line = createOutputEncoder('stream-json')
        .end({ message: 'why', reason, sessionId: SESSION })
      expect(JSON.parse(line)).toMatchObject({ message: 'why', reason, type: 'result' })
    }
  })
})
