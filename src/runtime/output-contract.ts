import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Envelope schema version. Consumers pin it. It is bumped only when an existing
 * field changes meaning or disappears; adding a new optional field does not
 * bump it, so a reader that ignores unknown keys keeps working.
 */
export const OUTPUT_ENVELOPE_VERSION = 1

export type OutputFormat = 'json' | 'stream-json' | 'text'

export const OUTPUT_FORMATS: readonly OutputFormat[] = Object.freeze([
  'json',
  'stream-json',
  'text',
])

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value)
}

export type OutputExitReason =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interaction-required'

export interface OutputResult {
  readonly message?: string
  readonly reason: OutputExitReason
  readonly sessionId: string
}

/** One envelope on the wire. Extra fields are additive; `v` gates the rest. */
export type OutputEnvelope = {
  readonly seq: number
  readonly sessionId: string
  readonly type: 'assistant'
  readonly text: string
  readonly v: number
} | {
  readonly callId?: string
  readonly name: string
  readonly seq: number
  readonly sessionId: string
  readonly type: 'tool-call'
  readonly v: number
} | {
  readonly callId?: string
  readonly failed: boolean
  readonly seq: number
  readonly sessionId: string
  readonly type: 'tool-result'
  readonly v: number
} | {
  readonly message?: string
  readonly reason: OutputExitReason
  readonly sessionId: string
  readonly type: 'result'
  readonly v: number
}

const MAX_TEXT_CODE_UNITS = 1_000_000

function boundedText(value: string): string {
  return value.length <= MAX_TEXT_CODE_UNITS
    ? value
    : `${value.slice(0, MAX_TEXT_CODE_UNITS - 1)}…`
}

/**
 * Concatenate the model-visible text of a message. Reasoning blocks are
 * deliberately excluded: they are not the answer, and a piped consumer that
 * treated them as one would act on the model's scratch work.
 */
export function assistantText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return boundedText(parts.join(''))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project one durable event onto its envelope, or `undefined` when the event
 * carries nothing a non-interactive consumer can act on. Unknown event types
 * are skipped rather than guessed at, which keeps a newer Harness from breaking
 * the contract.
 */
export function envelopeFor(
  event: SessionEvent,
  sessionId: string,
): OutputEnvelope | undefined {
  const data: unknown = event.data
  if (event.type === 'assistant/message') {
    if (!isRecord(data) || !isRecord(data.message)) return undefined
    const content = data.message.content
    if (!Array.isArray(content)) return undefined
    const text = assistantText(content as readonly ContentBlock[])
    if (text === '') return undefined
    return {
      seq: event.seq,
      sessionId,
      text,
      type: 'assistant',
      v: OUTPUT_ENVELOPE_VERSION,
    }
  }
  if (event.type === 'tool/call') {
    if (!isRecord(data)) return undefined
    const name = typeof data.name === 'string' ? data.name : undefined
    if (name === undefined) return undefined
    return {
      ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
      name,
      seq: event.seq,
      sessionId,
      type: 'tool-call',
      v: OUTPUT_ENVELOPE_VERSION,
    }
  }
  if (event.type === 'tool/result') {
    if (!isRecord(data)) return undefined
    return {
      ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
      failed: data.isError === true || data.failed === true,
      seq: event.seq,
      sessionId,
      type: 'tool-result',
      v: OUTPUT_ENVELOPE_VERSION,
    }
  }
  return undefined
}

export function resultEnvelope(result: OutputResult): OutputEnvelope {
  return {
    ...(result.message === undefined ? {} : { message: boundedText(result.message) }),
    reason: result.reason,
    sessionId: result.sessionId,
    type: 'result',
    v: OUTPUT_ENVELOPE_VERSION,
  }
}

/**
 * Encodes durable events into one output format.
 *
 * The encoder is pure and synchronous: it returns the exact bytes to write and
 * never writes them itself, so ordering and backpressure stay owned by the one
 * caller that also owns the stream.
 */
export interface OutputEncoder {
  /** Bytes for one durable event; empty when the event carries nothing. */
  event(event: SessionEvent, sessionId: string): string
  /** Terminal bytes. For `json` this is where the single document is emitted. */
  end(result: OutputResult): string
}

class TextEncoder_ implements OutputEncoder {
  event(event: SessionEvent, sessionId: string): string {
    const envelope = envelopeFor(event, sessionId)
    // Text is for humans and for `grep`: only the answer goes to stdout.
    return envelope?.type === 'assistant' ? `${envelope.text}\n` : ''
  }

  end(result: OutputResult): string {
    // A clean completion adds no trailer, so `--print` output pipes verbatim.
    if (result.reason === 'completed') return ''
    return `${result.reason}${result.message === undefined ? '' : `: ${result.message}`}\n`
  }
}

class StreamJsonEncoder implements OutputEncoder {
  event(event: SessionEvent, sessionId: string): string {
    const envelope = envelopeFor(event, sessionId)
    return envelope === undefined ? '' : `${JSON.stringify(envelope)}\n`
  }

  end(result: OutputResult): string {
    return `${JSON.stringify(resultEnvelope(result))}\n`
  }
}

/**
 * Buffers every envelope into one document. Chosen only when the consumer asked
 * for `json`, because holding the whole run in memory is exactly what
 * `stream-json` exists to avoid.
 */
class JsonEncoder implements OutputEncoder {
  readonly #envelopes: OutputEnvelope[] = []

  event(event: SessionEvent, sessionId: string): string {
    const envelope = envelopeFor(event, sessionId)
    if (envelope !== undefined) this.#envelopes.push(envelope)
    return ''
  }

  end(result: OutputResult): string {
    const document = {
      envelopes: [...this.#envelopes, resultEnvelope(result)],
      v: OUTPUT_ENVELOPE_VERSION,
    }
    return `${JSON.stringify(document)}\n`
  }
}

export function createOutputEncoder(format: OutputFormat): OutputEncoder {
  if (format === 'json') return new JsonEncoder()
  if (format === 'stream-json') return new StreamJsonEncoder()
  return new TextEncoder_()
}

/**
 * Process exit code for a run outcome. `interaction-required` is its own code
 * because a script that hit an approval prompt did not fail — it needs a human,
 * and a caller retrying it unchanged will hit the same wall.
 */
export function exitCodeFor(reason: OutputExitReason): number {
  switch (reason) {
    case 'completed':
      return 0
    case 'failed':
      return 1
    case 'cancelled':
      return 130
    case 'interaction-required':
      return 2
  }
}
