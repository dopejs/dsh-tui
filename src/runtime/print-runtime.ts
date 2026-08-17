import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { attachAgent, type AgentAttachmentRequest } from './agent-attachment'
import type { OutputFormat } from './output-contract'
import {
  InteractionRequiredError,
  runPrint,
  type PrintRunResult,
  type PrintStreams,
} from './print-runner'

export interface PrintRuntimeOptions {
  readonly format: OutputFormat
  readonly prompt: string
  readonly request: AgentAttachmentRequest
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly streams: PrintStreams
}

/**
 * Refuse every human interaction for the duration of a non-interactive run.
 *
 * There is no terminal to prompt on, and answering by default would grant
 * authority the user never gave — so both seams are declined and the run stops
 * with `interaction-required` rather than proceeding on an assumption.
 *
 * @returns a disposer that lifts the refusals, and a reader for the first one hit.
 */
export function refuseInteractions(ctx: Context): {
  dispose: () => void
  first: () => InteractionRequiredError | undefined
} {
  let first: InteractionRequiredError | undefined
  const record = (what: string) => {
    first ??= new InteractionRequiredError(what)
    return first
  }
  const disposers: (() => void)[] = []

  try {
    disposers.push(ctx.on('approval/request', async (request) => {
      record(`approval for ${request.toolName}`)
      // 'rejected' is the fail-closed answer: the tool does not run.
      return 'rejected'
    }))
  } catch {
    // A composition without the approval waterfall simply never asks.
  }

  const userQuestions = ctx.get('userQuestions')
  if (userQuestions !== undefined) {
    try {
      disposers.push(userQuestions.registerProvider({
        ask: async () => {
          throw record('a question that needs a human answer')
        },
        name: 'dsh-tui-print',
      } as never))
    } catch {
      // Provider registration is best-effort; the approval refusal still holds.
    }
  }

  return {
    dispose: () => {
      for (const disposer of disposers.reverse()) {
        try {
          disposer()
        } catch {
          // Teardown of a refusal must not fail the run's exit path.
        }
      }
    },
    first: () => first,
  }
}

/**
 * Run one prompt with no terminal state mounted.
 *
 * The same attachment and durable-event path the interactive runtime uses is
 * shared here; only the presentation differs. Nothing Ink- or TTY-related is
 * constructed, so `--print` works on a pipe, in CI, and without a controlling
 * terminal.
 */
export async function startPrintRuntime(
  ctx: Context,
  options: PrintRuntimeOptions,
): Promise<PrintRunResult> {
  const refusals = refuseInteractions(ctx)
  try {
    return await runPrint(
      {
        run: async (prompt, onEvent, signal) => {
          let deliver: (event: SessionEvent) => void = onEvent
          const attachment = await attachAgent(ctx, {
            onEvents: (batch) => {
              for (const event of batch.events) deliver(event)
            },
            request: options.request,
            signal,
          })
          try {
            await sendAndSettle(ctx, attachment.agent, prompt, signal)
            const interaction = refusals.first()
            if (interaction !== undefined) throw interaction
          } finally {
            // Events emitted during teardown belong to no turn the caller asked
            // for, so the sink is closed before the attachment unwinds.
            deliver = () => undefined
            await attachment.dispose()
          }
        },
      },
      options.streams,
      {
        format: options.format,
        prompt: options.prompt,
        sessionId: options.sessionId,
        signal: options.signal,
      },
    )
  } finally {
    refusals.dispose()
  }
}

/**
 * Deliver the prompt and wait for the agent to go idle. A non-interactive run
 * owns exactly one turn: it does not follow up, and it does not return while
 * the loop is still producing durable events.
 */
async function sendAndSettle(
  ctx: Context,
  agent: Agent,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  // Subscribe before delivering: `followup` enters `running` synchronously, so
  // a listener attached afterwards could miss the transition back to `idle`.
  const settled = new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      stopStatus()
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      finish(() => reject(signal.reason instanceof Error
        ? signal.reason
        : new Error('The run was cancelled.')))
    }
    const stopStatus = ctx.on('agent/status', (payload) => {
      if (payload.agent !== agent || payload.status !== 'idle') return
      finish(resolve)
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })

  agent.followup(createUserMessage({
    content: [{ text: prompt, type: 'text' }],
    source: { kind: 'user' },
  }))
  await settled
  signal.throwIfAborted()
}
