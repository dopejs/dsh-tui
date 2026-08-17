import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  InteractionRequiredError,
  readPipedPrompt,
  runPrint,
  type PrintAgentRun,
  type PrintSink,
} from './print-runner'

const SESSION = 'session-1'

/** `process.stdin` is an async iterable; the tests must present the same shape. */
async function* piped(
  ...chunks: readonly (string | Uint8Array)[]
): AsyncIterable<string | Uint8Array> {
  for (const chunk of chunks) yield chunk
}

function assistant(seq: number, text: string): SessionEvent {
  return {
    data: {
      message: {
        content: [{ text, type: 'text' }],
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

class FakeSink implements PrintSink {
  readonly chunks: string[] = []
  /** Number of writes to accept before reporting backpressure. */
  acceptBeforeBackpressure = Number.POSITIVE_INFINITY
  drainRequests = 0
  failWrite = false
  #pendingDrain: (() => void) | undefined

  get text(): string {
    return this.chunks.join('')
  }

  write(chunk: string): boolean {
    if (this.failWrite) throw new Error('EPIPE')
    this.chunks.push(chunk)
    return this.chunks.length < this.acceptBeforeBackpressure
  }

  once(_event: 'drain', listener: () => void): void {
    this.drainRequests += 1
    this.#pendingDrain = listener
    // A real stream drains asynchronously; resolving on a microtask keeps the
    // await meaningful without a timer.
    queueMicrotask(() => {
      const pending = this.#pendingDrain
      this.#pendingDrain = undefined
      pending?.()
    })
  }
}

function streams() {
  return { stderr: new FakeSink(), stdout: new FakeSink() }
}

function agentEmitting(events: readonly SessionEvent[]): PrintAgentRun {
  return {
    run: async (_prompt, onEvent) => {
      for (const event of events) onEvent(event)
    },
  }
}

describe('readPipedPrompt (M5.1)', () => {
  it('reads and trims a piped prompt', async () => {
    await expect(readPipedPrompt(piped('  explain ', 'this  '))).resolves.toBe('explain this')
  })

  it('decodes byte chunks', async () => {
    const bytes = new TextEncoder().encode('héllo')
    await expect(readPipedPrompt(piped(bytes.slice(0, 3), bytes.slice(3)))).resolves.toBe('héllo')
  })

  // An empty pipe is not an empty prompt: the caller needs to tell them apart
  // to decide between reading argv and refusing the run.
  it('returns undefined for an empty pipe', async () => {
    await expect(readPipedPrompt(piped())).resolves.toBeUndefined()
    await expect(readPipedPrompt(piped('   \n  '))).resolves.toBeUndefined()
  })

  it('refuses an unbounded pipe rather than buffering it', async () => {
    await expect(readPipedPrompt(piped('x'.repeat(1_000_001))))
      .rejects.toThrow('exceeds 1000000 code units')
  })
})

describe('runPrint (M5.1)', () => {
  it('writes only run output to stdout and exits zero', async () => {
    const io = streams()
    const result = await runPrint(
      agentEmitting([assistant(1, 'first'), assistant(2, 'second')]),
      io,
      { format: 'text', prompt: 'go', sessionId: SESSION },
    )

    expect(result).toEqual({ exitCode: 0, reason: 'completed' })
    expect(io.stdout.text).toBe('first\nsecond\n')
    expect(io.stderr.text).toBe('')
  })

  it('preserves event order under backpressure', async () => {
    const io = streams()
    io.stdout.acceptBeforeBackpressure = 1
    const events = Array.from({ length: 6 }, (_, index) => assistant(index + 1, `line${String(index)}`))

    await runPrint(agentEmitting(events), io, {
      format: 'stream-json',
      prompt: 'go',
      sessionId: SESSION,
    })

    expect(io.stdout.drainRequests).toBeGreaterThan(0)
    const seqs = io.stdout.text.trimEnd().split('\n')
      .map(line => (JSON.parse(line) as { seq?: number }).seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, undefined])
  })

  it('keeps diagnostics off stdout so a redirect never loses them', async () => {
    const io = streams()
    const agent: PrintAgentRun = {
      run: async () => {
        throw new Error('model unavailable')
      },
    }

    const result = await runPrint(agent, io, {
      format: 'text',
      prompt: 'go',
      sessionId: SESSION,
    })

    expect(result).toEqual({ exitCode: 1, reason: 'failed' })
    expect(io.stderr.text).toContain('model unavailable')
    expect(io.stdout.text).not.toContain('model unavailable\nfailed')
    expect(io.stdout.text).toBe('failed: model unavailable\n')
  })

  // No terminal exists to answer with, and answering by default would grant
  // authority the user never gave.
  it('fails closed when the run needs a human', async () => {
    const io = streams()
    const agent: PrintAgentRun = {
      run: async () => {
        throw new InteractionRequiredError('approval for bash')
      },
    }

    const result = await runPrint(agent, io, {
      format: 'stream-json',
      prompt: 'go',
      sessionId: SESSION,
    })

    expect(result).toEqual({ exitCode: 2, reason: 'interaction-required' })
    const last = JSON.parse(io.stdout.text.trimEnd().split('\n').at(-1) ?? '{}') as {
      message?: string
      reason?: string
    }
    expect(last.reason).toBe('interaction-required')
    expect(last.message).toContain('approval for bash')
    expect(io.stderr.text).toContain('approval for bash')
  })

  it('reports cancellation distinctly from failure', async () => {
    const io = streams()
    const controller = new AbortController()
    const agent: PrintAgentRun = {
      run: async (_prompt, onEvent, signal) => {
        onEvent(assistant(1, 'partial'))
        controller.abort()
        signal.throwIfAborted()
      },
    }

    const result = await runPrint(agent, io, {
      format: 'text',
      prompt: 'go',
      sessionId: SESSION,
      signal: controller.signal,
    })

    expect(result).toEqual({ exitCode: 130, reason: 'cancelled' })
    expect(io.stdout.text).toContain('partial')
    controller.abort()
  })

  it('forwards an already-aborted signal without starting work', async () => {
    const io = streams()
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(async (_p: string, _e: unknown, signal: AbortSignal) => {
      signal.throwIfAborted()
    })

    const result = await runPrint({ run }, io, {
      format: 'text',
      prompt: 'go',
      sessionId: SESSION,
      signal: controller.signal,
    })

    expect(result.reason).toBe('cancelled')
    expect(run.mock.calls[0]?.[2].aborted).toBe(true)
  })

  it('emits one json document with the result last', async () => {
    const io = streams()
    await runPrint(agentEmitting([assistant(1, 'hi')]), io, {
      format: 'json',
      prompt: 'go',
      sessionId: SESSION,
    })

    const document = JSON.parse(io.stdout.text) as { envelopes: { type: string }[] }
    expect(document.envelopes.map(envelope => envelope.type)).toEqual(['assistant', 'result'])
  })

  it('still reports an exit code when stdout breaks mid-run', async () => {
    const io = streams()
    io.stdout.failWrite = true

    const result = await runPrint(agentEmitting([assistant(1, 'hi')]), io, {
      format: 'text',
      prompt: 'go',
      sessionId: SESSION,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toBe('failed')
    expect(io.stderr.text).toContain('EPIPE')
  })

  it('does not mask the exit code when the diagnostic write also fails', async () => {
    const io = streams()
    io.stderr.failWrite = true
    const agent: PrintAgentRun = {
      run: async () => {
        throw new Error('model unavailable')
      },
    }

    const result = await runPrint(agent, io, {
      format: 'text',
      prompt: 'go',
      sessionId: SESSION,
    })

    expect(result).toEqual({ exitCode: 1, reason: 'failed' })
  })

  it('writes no trailer to stderr on a clean run', async () => {
    const io = streams()
    await runPrint(agentEmitting([assistant(1, 'hi')]), io, {
      format: 'text',
      prompt: 'go',
      sessionId: SESSION,
    })
    expect(io.stderr.text).toBe('')
  })
})
