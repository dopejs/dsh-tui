import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'

import { AgentStatusController } from './model/agent-status-controller'
import { EditorController } from './model/editor-controller'
import { InteractionController } from './model/interaction-controller'
import { TranscriptController } from './model/transcript-controller'
import { reduceTranscriptBatch } from './model/transcript-reducer'
import { ToolTranscriptProjector } from './presentation/tools'
import { attachAgent, type AgentAttachmentRequest } from './runtime/agent-attachment'
import { createRuntimePlugin } from './runtime/cordis-runtime'
import { InputController } from './runtime/input-controller'
import { InteractionScheduler } from './runtime/interaction-scheduler'
import { ResourceOwner } from './runtime/resource-owner'
import type { TuiStartupValues } from './startup'
import {
  mountInkApplication,
  type InkApplicationOptions,
  type MountedInkApplication,
} from './ui/ink-app-runtime'

export const name = 'tui-runtime'
export const inject = [
  'agentDefaultModel',
  'agents',
  'commands',
  'sessions',
  'tools',
  'tuiStartup',
  'userQuestions',
]

export interface RuntimeDependencies {
  readonly cwd: () => string
  readonly mountApplication: (options: InkApplicationOptions) => MountedInkApplication
  readonly sessionId: () => string
  readonly stdin: Pick<NodeJS.ReadStream, 'isTTY'>
  readonly stdout: Pick<NodeJS.WriteStream, 'isTTY'>
}

const defaultDependencies: RuntimeDependencies = {
  cwd: () => process.cwd(),
  mountApplication: mountInkApplication,
  sessionId: () => `session-${randomUUID()}`,
  stdin: process.stdin,
  stdout: process.stdout,
}

function diagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 2_000 ? message : `${message.slice(0, 1_999)}…`
}

function writeDiagnosticFile(message: string): void {
  const path = process.env.DSH_TUI_LOG_FILE
  if (path === undefined || path === '') return
  try {
    appendFileSync(path, `[dsh-tui] ${message}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
  } catch {
    // The configured file is optional; the buffered Cordis logger remains the fallback.
  }
}

class DiagnosticBuffer {
  readonly #errors: string[] = []
  #dropped = 0

  report = (error: unknown): void => {
    const message = diagnosticMessage(error)
    writeDiagnosticFile(message)
    if (this.#errors.length >= 64) {
      this.#dropped += 1
      return
    }
    this.#errors.push(message)
  }

  flush(ctx: Context): void {
    let logger: ReturnType<Context['logger']> | undefined
    try {
      logger = ctx.logger(name)
    } catch {
      // Terminal cleanup must not fail because the diagnostic backend is unavailable.
    }
    for (const message of this.#errors) {
      try {
        logger?.error(message)
      } catch {
        // Each diagnostic has already been offered to the optional file sink.
      }
    }
    if (this.#dropped > 0) {
      const message = `${String(this.#dropped)} additional TUI diagnostics were dropped`
      writeDiagnosticFile(message)
      try {
        logger?.error(message)
      } catch {
        // Resource disposal remains authoritative when reporting is degraded.
      }
    }
    this.#errors.length = 0
    this.#dropped = 0
  }
}

function requestFor(startup: TuiStartupValues, dependencies: RuntimeDependencies): AgentAttachmentRequest {
  return startup.resumeSessionId === undefined
    ? {
        cwd: dependencies.cwd(),
        kind: 'create',
        sessionId: dependencies.sessionId(),
      }
    : { kind: 'resume', sessionId: startup.resumeSessionId }
}

function combineStartupFailure(error: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [error, cleanupError],
    'TUI runtime startup failed and cleanup did not complete cleanly',
  )
}

export async function startTuiRuntime(
  ctx: Context,
  startup: TuiStartupValues,
  signal: AbortSignal,
  dependencies: RuntimeDependencies = defaultDependencies,
): Promise<() => Promise<void>> {
  if (dependencies.stdin.isTTY !== true || dependencies.stdout.isTTY !== true) {
    throw new Error('dsh-tui requires interactive TTY stdin and stdout')
  }
  const appExit = ctx.get('appExit')
  const commands = ctx.get('commands')
  const sessions = ctx.get('sessions')
  const tools = ctx.get('tools')
  const userQuestions = ctx.get('userQuestions')
  if (appExit === undefined) throw new Error('dsh-tui requires the launcher appExit service')
  if (commands === undefined || sessions === undefined || tools === undefined || userQuestions === undefined) {
    throw new Error('dsh-tui is missing one or more required Harness services')
  }

  const owner = new ResourceOwner()
  const diagnostics = new DiagnosticBuffer()
  let runtimeDisposing = false
  let rendererFailure: unknown
  let disposing: Promise<void> | undefined
  const disposeRuntime = (): Promise<void> => {
    disposing ??= (async () => {
      runtimeDisposing = true
      writeDiagnosticFile('runtime disposal started')
      let cleanupError: unknown
      try {
        await owner.dispose()
      } catch (error) {
        cleanupError = error
      }
      diagnostics.flush(ctx)
      writeDiagnosticFile('runtime disposal finished')
      if (cleanupError !== undefined && rendererFailure !== undefined) {
        throw new AggregateError(
          [rendererFailure, cleanupError],
          'TUI renderer and runtime cleanup both failed',
        )
      }
      if (cleanupError !== undefined) throw cleanupError
      if (rendererFailure !== undefined) throw rendererFailure
    })()
    return disposing
  }
  let exitRequest: Promise<void> | undefined
  const requestExit = (code: number): void => {
    exitRequest ??= Promise.resolve().then(disposeRuntime).then(
      () => { appExit(code) },
      (error: unknown) => {
        diagnostics.report(error)
        appExit(1)
      },
    )
  }
  let projector: ToolTranscriptProjector | undefined
  const transcript = new TranscriptController({
    projectBatch: (state, events) => projector?.reduceBatch(state, events)
      ?? reduceTranscriptBatch(state, events),
    reportError: diagnostics.report,
  })
  owner.own('transcript controller', () => transcript.dispose())

  try {
    const attachment = await attachAgent(ctx, {
      onAttached: (agent) => {
        projector = new ToolTranscriptProjector({
          agent,
          reportError: diagnostics.report,
          tools,
        })
      },
      onError: (error) => {
        diagnostics.report(error)
        requestExit(1)
      },
      onEvents: ({ events }, eventSignal) => {
        transcript.accept(events, eventSignal)
      },
      request: requestFor(startup, dependencies),
      signal,
    })
    owner.own('agent attachment', () => attachment.dispose())
    owner.own('session durability flush', () => sessions.flush(attachment.agent.session).then(() => undefined))

    const status = new AgentStatusController(attachment.agent, diagnostics.report)
    owner.own('agent status controller', () => status.dispose())
    const editor = new EditorController()
    owner.own('editor controller', () => editor.dispose())
    const input = new InputController({ agent: attachment.agent, commands })
    owner.own('input controller', () => input.dispose())
    const unregisterExitCommand = commands.register({
      description: 'Exit the interactive TUI after graceful teardown',
      handler: () => {
        setImmediate(() => {
          writeDiagnosticFile('exit command requested')
          requestExit(0)
        })
        return { kind: 'success', text: 'Exiting TUI.' }
      },
      name: 'exit',
      recordInput: false,
    })
    owner.own('exit command', unregisterExitCommand)
    const interaction = new InteractionController(diagnostics.report)
    owner.own('interaction controller', () => interaction.dispose())
    const scheduler = new InteractionScheduler({
      agent: attachment.agent,
      host: interaction,
      userQuestions,
    })
    owner.own('interaction scheduler', () => scheduler.dispose())

    const application = dependencies.mountApplication({
      editor,
      input,
      interaction,
      modelLabel: [attachment.agent.options.provider, attachment.agent.options.model]
        .filter((value): value is string => value !== undefined && value !== '')
        .join('/'),
      onQuit: requestExit,
      sessionId: String(attachment.agent.session.id),
      status,
      transcript,
      workspace: attachment.agent.session.header.cwd ?? dependencies.cwd(),
    })
    owner.own('Ink application and terminal state', () => application.dispose())
    void application.exited.catch((error: unknown) => {
      rendererFailure = error
      diagnostics.report(error)
      if (!runtimeDisposing) requestExit(1)
    })
  } catch (error) {
    try {
      await owner.dispose()
    } catch (cleanupError) {
      throw combineStartupFailure(error, cleanupError)
    }
    throw error
  }

  return disposeRuntime
}

const runtimePlugin = createRuntimePlugin({
  reportError: (ctx, error) => {
    const message = diagnosticMessage(error)
    writeDiagnosticFile(message)
    ctx.logger(name).error(message)
    ctx.get('appExit')?.(1)
  },
  start: (ctx, signal) => {
    const startup = ctx.get('tuiStartup')
    if (startup === undefined) throw new Error('dsh-tui requires the tuiStartup service')
    return startTuiRuntime(ctx, startup, signal)
  },
})

export function apply(ctx: Context): ReturnType<typeof runtimePlugin.apply> {
  return runtimePlugin.apply(ctx, undefined)
}
