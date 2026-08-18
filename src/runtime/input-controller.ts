import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { parseCommand, type CommandExecution, type CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

import {
  expandMessage,
  findReferences,
  resolveReferences,
  type ReferenceDependencies,
  type ResolvedReference,
} from '../model/reference-resolver'

const DEFAULT_MAX_INPUT_CHARS = 100_000

type CommandExecutor = Pick<CommandRuntime, 'execute'>

export type SubmissionMode = 'followup' | 'steer'

export type InputSubmission =
  | {
      readonly kind: 'message'
      readonly message: UserMessage
      readonly mode: SubmissionMode
      /** Present when the message carried `@path` references. */
      readonly references?: readonly ResolvedReference[]
    }
  | {
      readonly execution: CommandExecution
      readonly kind: 'command'
    }
  | {
      readonly code: 'busy' | 'empty' | 'invalid-command' | 'too-long' | 'unknown-command'
      readonly kind: 'rejected'
      readonly message: string
    }
  | {
      readonly error: unknown
      readonly kind: 'command-error'
      readonly message: string
    }
  | {
      readonly error: unknown
      readonly kind: 'message-error'
      readonly message: string
      readonly mode: SubmissionMode
    }
  | {
      readonly kind: 'command-cancelled'
    }

export interface InputControllerOptions {
  readonly agent: Agent
  readonly commands: CommandExecutor
  readonly maxInputChars?: number
  /** Absent leaves `@path` text untouched, which is the correct degradation. */
  readonly references?: ReferenceDependencies
}

function validateMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_INPUT_CHARS
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) {
    throw new RangeError('maxInputChars must be a safe integer between 1 and 1000000')
  }
  return maximum
}

function disposedError(): Error {
  return new Error('Input controller is disposed')
}

function renderError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '<unrenderable command failure>'
  }
}

interface ActiveCommand {
  readonly abort: AbortController
  readonly task: Promise<InputSubmission>
}

export class InputController {
  readonly #agent: Agent
  readonly #commands: CommandExecutor
  readonly #lifecycleAbort = new AbortController()
  readonly #maxInputChars: number
  #activeCommand: ActiveCommand | undefined
  #disposed = false
  #disposing: Promise<void> | undefined

  readonly #references: ReferenceDependencies | undefined

  constructor(options: InputControllerOptions) {
    this.#agent = options.agent
    this.#commands = options.commands
    this.#maxInputChars = validateMaximum(options.maxInputChars)
    this.#references = options.references
  }

  get commandPending(): boolean {
    return this.#activeCommand !== undefined
  }

  get agentStatus(): AgentStatus {
    return this.#agent.status
  }

  async submit(
    line: string,
    mode: SubmissionMode,
    signal?: AbortSignal,
  ): Promise<InputSubmission> {
    if (this.#disposed) throw disposedError()
    if (line.length > this.#maxInputChars) {
      return {
        code: 'too-long',
        kind: 'rejected',
        message: `Input exceeds the ${String(this.#maxInputChars)} character limit`,
      }
    }
    if (line.trim().length === 0) {
      return { code: 'empty', kind: 'rejected', message: 'Input must not be empty' }
    }
    if (line.startsWith('/')) return this.#submitCommand(line, signal)

    // `@path` references are expanded before the message is delivered: the
    // user believes the file went with it, so a reference that cannot be read
    // is reported rather than silently dropped.
    let text = line
    let references: readonly ResolvedReference[] = []
    if (this.#references !== undefined && findReferences(line).length > 0) {
      try {
        references = await resolveReferences(line, this.#references)
        text = expandMessage(line, references)
      } catch (error) {
        return { error, kind: 'message-error', message: renderError(error), mode }
      }
    }

    try {
      const message = createUserMessage({
        content: [{ text, type: 'text' }],
        source: { kind: 'user' },
      })
      if (mode === 'steer') this.#agent.steer(message)
      else this.#agent.followup(message)
      return {
        kind: 'message',
        message,
        mode,
        ...(references.length === 0 ? {} : { references }),
      }
    } catch (error) {
      return { error, kind: 'message-error', message: renderError(error), mode }
    }
  }

  cancelAgent(): void {
    if (this.#disposed) throw disposedError()
    this.#agent.cancel({ kind: 'user' })
  }

  cancelCommand(): boolean {
    if (this.#disposed) throw disposedError()
    if (this.#activeCommand === undefined) return false
    this.#activeCommand.abort.abort(new Error('Command cancelled by user'))
    return true
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    this.#lifecycleAbort.abort(new Error('Input controller disposed'))
    this.#activeCommand?.abort.abort(new Error('Input controller disposed'))
    await this.#activeCommand?.task
  }

  #submitCommand(line: string, signal?: AbortSignal): Promise<InputSubmission> {
    if (this.#activeCommand !== undefined) {
      return Promise.resolve({
        code: 'busy',
        kind: 'rejected',
        message: 'Another command is still running',
      })
    }

    const parsed = parseCommand(line)
    if (parsed === undefined) {
      return Promise.resolve({
        code: 'invalid-command',
        kind: 'rejected',
        message: 'Invalid slash-command syntax',
      })
    }

    const abort = new AbortController()
    const combinedSignal = signal === undefined
      ? AbortSignal.any([abort.signal, this.#lifecycleAbort.signal])
      : AbortSignal.any([abort.signal, this.#lifecycleAbort.signal, signal])
    const task = this.#executeCommand(line, parsed.name, combinedSignal)
    const active: ActiveCommand = { abort, task }
    this.#activeCommand = active
    void task.then(() => {
      if (this.#activeCommand === active) this.#activeCommand = undefined
    })
    return task
  }

  async #executeCommand(
    line: string,
    commandName: string,
    signal: AbortSignal,
  ): Promise<InputSubmission> {
    try {
      const execution = await this.#commands.execute(this.#agent, line, signal)
      if (execution === undefined) {
        return {
          code: 'unknown-command',
          kind: 'rejected',
          message: `Unknown command /${commandName}`,
        }
      }
      return { execution, kind: 'command' }
    } catch (error) {
      if (signal.aborted) return { kind: 'command-cancelled' }
      return { error, kind: 'command-error', message: renderError(error) }
    }
  }
}
