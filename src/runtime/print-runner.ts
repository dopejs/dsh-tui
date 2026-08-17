import type { SessionEvent } from '@deepseek-ai/dsh-session'

import {
  createOutputEncoder,
  exitCodeFor,
  type OutputExitReason,
  type OutputFormat,
} from './output-contract'

const MAX_PROMPT_CODE_UNITS = 1_000_000

/** A writable byte sink that reports backpressure the way Node streams do. */
export interface PrintSink {
  /** Returns false when the buffer is full; the caller must await `drain`. */
  write(chunk: string): boolean
  once(event: 'drain', listener: () => void): void
}

export interface PrintStreams {
  /** Machine-readable run output. Nothing diagnostic is written here. */
  readonly stdout: PrintSink
  /** Diagnostics only, so redirecting stdout never loses an error. */
  readonly stderr: PrintSink
}

export interface PrintRunOptions {
  readonly format: OutputFormat
  readonly prompt: string
  readonly sessionId: string
  readonly signal?: AbortSignal
}

/**
 * The agent surface a non-interactive run needs: send a prompt, observe durable
 * events in order, and settle. Narrowed to this shape so the runner can be
 * exercised without a live Harness.
 */
export interface PrintAgentRun {
  /** Resolves when the turn settles; rejects on a run failure. */
  run(prompt: string, onEvent: (event: SessionEvent) => void, signal: AbortSignal): Promise<void>
}

export interface PrintRunResult {
  readonly exitCode: number
  readonly reason: OutputExitReason
}

function errorMessage(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error)
    return value.length <= 2_000 ? value : `${value.slice(0, 1_999)}…`
  } catch {
    return '<unrenderable failure>'
  }
}

/**
 * Read a piped prompt from stdin. Returns `undefined` for an empty pipe so the
 * caller can distinguish "nothing was piped" from "an empty string was piped".
 */
export async function readPipedPrompt(
  stdin: AsyncIterable<string | Uint8Array>,
): Promise<string | undefined> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stdin) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    if (text.length > MAX_PROMPT_CODE_UNITS) {
      throw new Error(`Piped prompt exceeds ${String(MAX_PROMPT_CODE_UNITS)} code units`)
    }
  }
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Write one chunk, awaiting `drain` when the sink is full.
 *
 * Without this a large run would buffer the whole transcript in memory when
 * stdout is a slow pipe, which is the failure `stream-json` exists to prevent.
 */
async function writeBackpressured(sink: PrintSink, chunk: string): Promise<void> {
  if (chunk === '') return
  if (sink.write(chunk)) return
  await new Promise<void>((resolve) => {
    sink.once('drain', resolve)
  })
}

/**
 * Raised when the run needs a human and no one can answer.
 *
 * A non-interactive run has no terminal to prompt on, so an approval request or
 * a question cannot be answered — and answering it by default would grant
 * authority the user never gave. The run stops and says which one it was.
 */
export class InteractionRequiredError extends Error {
  constructor(what: string) {
    super(`Non-interactive run needs a human: ${what}`)
    this.name = 'InteractionRequiredError'
  }
}

/**
 * Run one prompt without a terminal and encode the durable events it produces.
 *
 * Events are written in the order the session emits them, stdout carries only
 * run output, and stderr carries only diagnostics — so a caller that redirects
 * one never silently loses the other.
 */
export async function runPrint(
  agent: PrintAgentRun,
  streams: PrintStreams,
  options: PrintRunOptions,
): Promise<PrintRunResult> {
  const encoder = createOutputEncoder(options.format)
  const controller = new AbortController()
  const external = options.signal
  const forwardAbort = () => controller.abort()
  if (external?.aborted === true) controller.abort()
  external?.addEventListener('abort', forwardAbort)

  // Encoding stays synchronous and ordered; only the writes are awaited, and
  // they are chained so a slow sink cannot reorder them.
  let writes: Promise<void> = Promise.resolve()
  const enqueue = (chunk: string) => {
    writes = writes.then(() => writeBackpressured(streams.stdout, chunk))
  }

  let reason: OutputExitReason = 'completed'
  let message: string | undefined
  try {
    await agent.run(
      options.prompt,
      (event) => {
        enqueue(encoder.event(event, options.sessionId))
      },
      controller.signal,
    )
    await writes
  } catch (error) {
    await writes.catch(() => undefined)
    if (error instanceof InteractionRequiredError) {
      reason = 'interaction-required'
      message = error.message
    } else if (controller.signal.aborted) {
      reason = 'cancelled'
      message = 'The run was cancelled.'
    } else {
      reason = 'failed'
      message = errorMessage(error)
    }
  } finally {
    external?.removeEventListener('abort', forwardAbort)
  }

  try {
    await writeBackpressured(
      streams.stdout,
      encoder.end({
        ...(message === undefined ? {} : { message }),
        reason,
        sessionId: options.sessionId,
      }),
    )
  } catch (error) {
    // stdout is already unusable; the diagnostic still has to reach stderr.
    reason = reason === 'completed' ? 'failed' : reason
    message = errorMessage(error)
  }

  if (message !== undefined && reason !== 'completed') {
    try {
      await writeBackpressured(streams.stderr, `${message}\n`)
    } catch {
      // A failed diagnostic write must not mask the exit code the run earned.
    }
  }

  return { exitCode: exitCodeFor(reason), reason }
}
