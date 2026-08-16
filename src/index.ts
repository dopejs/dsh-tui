import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'

import { AgentStatusController } from './model/agent-status-controller'
import { ChangeIndexController } from './model/change-index-controller'
import { CommandPaletteController } from './model/command-palette-controller'
import { CompletionController } from './model/completion-controller'
import { EditorController } from './model/editor-controller'
import { InteractionController } from './model/interaction-controller'
import { OverlayController } from './model/overlay-controller'
import { PreferencesController } from './model/preferences-controller'
import { PermissionController } from './model/permission-controller'
import { RecoveryController } from './model/recovery-controller'
import { SessionCenterController } from './model/session-center-controller'
import { RuntimeStatusController } from './model/runtime-status-controller'
import { TranscriptController } from './model/transcript-controller'
import { reduceTranscriptBatch } from './model/transcript-reducer'
import { TranscriptViewportController } from './model/transcript-viewport-controller'
import { ToolTranscriptProjector } from './presentation/tools'
import { attachAgent, type AgentAttachmentRequest } from './runtime/agent-attachment'
import { createRuntimePlugin } from './runtime/cordis-runtime'
import { InputController } from './runtime/input-controller'
import { InteractionScheduler } from './runtime/interaction-scheduler'
import { ResourceOwner } from './runtime/resource-owner'
import { SessionAttachmentCoordinator } from './runtime/session-attachment-coordinator'
import { exportRawSession } from './runtime/session-export'
import { WorkspaceCompletionProvider } from './runtime/workspace-completion-provider'
import type { TuiStartupValues } from './startup'
import {
  mountInkApplication,
  type InkApplicationOptions,
  type MountedInkApplication,
  type TuiSessionBinding,
} from './ui/ink-app-runtime'

export const name = 'tui-runtime'
export const inject = [
  'agentDefaultModel',
  'agents',
  'commands',
  'llm',
  'sessionPersistence',
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

function requestFor(
  startup: TuiStartupValues,
  dependencies: RuntimeDependencies,
  modelSelection?: ModelSelection,
): AgentAttachmentRequest {
  return startup.resumeSessionId === undefined
    ? {
        cwd: dependencies.cwd(),
        kind: 'create',
        ...(modelSelection === undefined ? {} : { modelSelection }),
        sessionId: dependencies.sessionId(),
      }
    : { kind: 'resume', sessionId: startup.resumeSessionId }
}

export function parseModelSelector(value: string): ModelSelection {
  const separator = value.indexOf('/')
  if (
    separator < 1
    || separator === value.length - 1
    || value.trim() !== value
    || /\s/.test(value)
  ) {
    throw new Error('--model must use a non-empty provider/model value')
  }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) }
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
  const llm = ctx.get('llm')
  const permissionPresets = ctx.get('permissionPresets')
  const sessionPersistence = ctx.get('sessionPersistence')
  const sessions = ctx.get('sessions')
  const tools = ctx.get('tools')
  const userQuestions = ctx.get('userQuestions')
  if (appExit === undefined) throw new Error('dsh-tui requires the launcher appExit service')
  if (
    commands === undefined
    || llm === undefined
    || sessionPersistence === undefined
    || sessions === undefined
    || tools === undefined
    || userQuestions === undefined
  ) {
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
  try {
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
    const preferences = new PreferencesController()
    const coordinatorRef: { current?: SessionAttachmentCoordinator<TuiSessionBinding> } = {}

    const createBinding = async (
      request: AgentAttachmentRequest,
      bindingSignal: AbortSignal,
    ): Promise<TuiSessionBinding> => {
      const bindingOwner = new ResourceOwner()
      let projector: ToolTranscriptProjector | undefined
      const transcript = new TranscriptController({
        projectBatch: (state, events) => projector?.reduceBatch(state, events)
          ?? reduceTranscriptBatch(state, events),
        reportError: diagnostics.report,
      })
      bindingOwner.own('transcript controller', () => transcript.dispose())
      const viewport = new TranscriptViewportController(transcript)
      bindingOwner.own('transcript viewport controller', () => viewport.dispose())
      const changes = new ChangeIndexController()
      bindingOwner.own('change index controller', () => changes.dispose())
      const runtimeStatus = new RuntimeStatusController()
      bindingOwner.own('runtime status controller', () => runtimeStatus.dispose())
      try {
        const attachment = await attachAgent(ctx, {
          onAttached: (agent) => {
            runtimeStatus.setModel(agent.options)
            projector = new ToolTranscriptProjector({
              agent,
              onChangePresentation: intent => changes.record(intent),
              reportError: diagnostics.report,
              tools,
            })
          },
          onError: (error) => {
            diagnostics.report(error)
            requestExit(1)
          },
          onEvents: ({ events }, eventSignal) => {
            runtimeStatus.accept(events, eventSignal)
            transcript.accept(events, eventSignal)
          },
          request,
          signal: bindingSignal,
        })
        bindingOwner.own('agent attachment', () => attachment.dispose())
        bindingOwner.own(
          'session durability flush',
          () => sessions.flush(attachment.agent.session).then(() => undefined),
        )
        const status = new AgentStatusController(attachment.agent, diagnostics.report)
        bindingOwner.own('agent status controller', () => status.dispose())
        const permission = new PermissionController(attachment.agent, permissionPresets)
        bindingOwner.own('permission controller', () => permission.dispose())
        const editor = new EditorController()
        bindingOwner.own('editor controller', () => editor.dispose())
        const input = new InputController({ agent: attachment.agent, commands })
        bindingOwner.own('input controller', () => input.dispose())
        let exportLocation: string | undefined
        try {
          exportLocation = sessionPersistence.locate(attachment.agent.session.header)?.path
        } catch (error) {
          diagnostics.report(error)
        }
        const recovery = new RecoveryController({
          exportDetail: sessionPersistence.supportsRawArtifacts
            ? `Raw backend artifact${exportLocation === undefined ? '' : `: ${exportLocation}`}`
            : 'The configured backend has no verbatim per-session artifact.',
          operations: {
            ...(sessionPersistence.supportsRawArtifacts
              ? {
                  exportRaw: async (destination: string, operationSignal: AbortSignal) => {
                    if (operationSignal.aborted) throw operationSignal.reason
                    const participated = await sessions.flush(attachment.agent.session)
                    if (!participated) {
                      throw new Error('No durability listener participated before export')
                    }
                    if (operationSignal.aborted) throw operationSignal.reason
                    return exportRawSession({
                      destination,
                      persistence: sessionPersistence,
                      sessionId: String(attachment.agent.session.id),
                      signal: operationSignal,
                      workspace: attachment.agent.session.header.cwd ?? dependencies.cwd(),
                    })
                  },
                }
              : {}),
            flush: async (operationSignal) => {
              if (operationSignal.aborted) throw operationSignal.reason
              const participated = await sessions.flush(attachment.agent.session)
              if (operationSignal.aborted) throw operationSignal.reason
              return participated
            },
            fork: async (operationSignal) => {
              if (attachment.agent.status !== 'idle') {
                throw new Error('Conversation fork requires an idle agent')
              }
              const participated = await sessions.flush(attachment.agent.session)
              if (!participated) {
                throw new Error('No durability listener participated before fork')
              }
              if (operationSignal.aborted) throw operationSignal.reason
              if (attachment.agent.status !== 'idle') {
                throw new Error('Agent became busy while preparing the conversation fork')
              }
              const seed = attachment.agent.session.events
              const childSessionId = dependencies.sessionId()
              const parentSessionId = String(attachment.agent.session.id)
              if (childSessionId === parentSessionId) {
                throw new Error('Session id provider returned the current session id for a fork')
              }
              const activeCoordinator = coordinatorRef.current
              if (activeCoordinator === undefined) {
                throw new Error('Session transition coordinator is not ready')
              }
              if (activeCoordinator.getSnapshot().status !== 'attached') {
                throw new Error('Another session transition is already running')
              }
              const provider = attachment.agent.options.provider
              const model = attachment.agent.options.model
              const forkRequest: AgentAttachmentRequest = {
                cwd: attachment.agent.session.header.cwd ?? dependencies.cwd(),
                kind: 'fork',
                ...(provider === undefined || model === undefined
                  ? {}
                  : { modelSelection: { model, provider } }),
                parentSessionId,
                seed,
                sessionId: childSessionId,
              }
              const transition = activeCoordinator.createSession(
                childSessionId,
                transitionSignal => createBinding(forkRequest, transitionSignal),
                signal,
              )
              void transition.catch(diagnostics.report)
              return {
                boundary: seed.at(-1)?.seq ?? -1,
                sessionId: childSessionId,
              }
            },
          },
          sessionId: String(attachment.agent.session.id),
          suggestedExportDestination: `session-${String(attachment.agent.session.id)
            .replaceAll(/[^a-zA-Z0-9._-]/gu, '_')}.jsonl`,
        })
        bindingOwner.own('recovery controller', () => recovery.dispose())
        const overlay = new OverlayController()
        bindingOwner.own('overlay controller', () => overlay.dispose())
        const palette = new CommandPaletteController({
          list: () => commands.list(attachment.agent),
          subscribe: listener => ctx.on('commands/change', listener),
        })
        bindingOwner.own('command palette controller', () => palette.dispose())
        const workspace = attachment.agent.session.header.cwd ?? dependencies.cwd()
        const completion = new CompletionController(new WorkspaceCompletionProvider({
          listCommands: () => commands.list(attachment.agent),
          workspace,
        }))
        bindingOwner.own('completion controller', () => completion.dispose())
        const interaction = new InteractionController(diagnostics.report)
        bindingOwner.own('interaction controller', () => interaction.dispose())
        const scheduler = new InteractionScheduler({
          agent: attachment.agent,
          host: interaction,
          userQuestions,
        })
        bindingOwner.own('interaction scheduler', () => scheduler.dispose())
        const sessionId = String(attachment.agent.session.id)
        let acceptingInput = true
        let bindingDisposal: Promise<void> | undefined
        return {
          application: {
            acceptsInput: () => acceptingInput,
            changes,
            completion,
            editor,
            input,
            interaction,
            modelLabel: [attachment.agent.options.provider, attachment.agent.options.model]
              .filter((value): value is string => value !== undefined && value !== '')
              .join('/'),
            overlay,
            palette,
            permission,
            preferences,
            recovery,
            sessionId,
            runtimeStatus,
            status,
            transcript,
            viewport,
            workspace,
          },
          dispose() {
            acceptingInput = false
            bindingDisposal ??= bindingOwner.dispose()
            return bindingDisposal
          },
          setAcceptingInput(accepting) {
            acceptingInput = accepting
          },
          sessionId,
        }
      } catch (error) {
        try {
          await bindingOwner.dispose()
        } catch (cleanupError) {
          throw combineStartupFailure(error, cleanupError)
        }
        throw error
      }
    }

    let startupSelection: ModelSelection | undefined
    if (startup.model !== undefined) {
      startupSelection = parseModelSelector(startup.model)
      const resolved = await llm.resolveModelInfo(
        startupSelection.provider,
        startupSelection.model,
        signal,
      )
      if (resolved.provider !== startupSelection.provider || resolved.id !== startupSelection.model) {
        throw new Error('Model resolver returned a different provider/model identity')
      }
    }
    const initialBinding = await createBinding(
      requestFor(startup, dependencies, startupSelection),
      signal,
    )
    const coordinator = new SessionAttachmentCoordinator<TuiSessionBinding>({
      factory: {
        preflight: async (sessionId, preflightSignal) => {
          await sessionPersistence.inspect(SessionId(sessionId), preflightSignal)
        },
        resume: (sessionId, resumeSignal) => createBinding({
          kind: 'resume',
          sessionId,
        }, resumeSignal),
      },
      initial: initialBinding,
      onFatal: (error) => {
        diagnostics.report(error)
        requestExit(1)
      },
      signal,
    })
    coordinatorRef.current = coordinator
    owner.own('session attachment coordinator', () => coordinator.dispose())
    const sessionCenter = new SessionCenterController(sessionPersistence, coordinator, {
      currentSessionId: initialBinding.sessionId,
    })
    owner.own('session center controller', () => sessionCenter.dispose())
    const syncSessionCenter = () => {
      const snapshot = coordinator.getSnapshot()
      if (snapshot.status === 'attached' && snapshot.binding !== undefined) {
        sessionCenter.setCurrentSession(snapshot.binding.sessionId)
      }
    }
    const stopSessionCenterSync = coordinator.subscribe(syncSessionCenter)
    owner.own('session center identity sync', stopSessionCenterSync)
    syncSessionCenter()
    const application = dependencies.mountApplication({
      onQuit: requestExit,
      sessionCenter,
      sessions: coordinator,
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
