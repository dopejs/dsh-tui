import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-skill'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'

import { ActivityCenterController } from './model/activity-center-controller'
import { AttachmentsController } from './model/attachments-controller'
import { AgentStatusController } from './model/agent-status-controller'
import { ChangeIndexController } from './model/change-index-controller'
import { CommandPaletteController } from './model/command-palette-controller'
import { CompletionController } from './model/completion-controller'
import { EditorController } from './model/editor-controller'
import { InteractionController } from './model/interaction-controller'
import { JobsController } from './model/jobs-controller'
import { McpInventoryController } from './model/mcp-inventory-controller'
import { OverlayController } from './model/overlay-controller'
import { PreferencesController, resolvePreferences } from './model/preferences-controller'
import { PermissionController } from './model/permission-controller'
import { PluginInventoryController } from './model/plugin-inventory-controller'
import { ProjectionHubController } from './model/projection-hub-controller'
import { RecoveryController } from './model/recovery-controller'
import { SessionCenterController } from './model/session-center-controller'
import { SkillsController } from './model/skills-controller'
import { SubagentTreeController } from './model/subagent-tree-controller'
import { RuntimeStatusController } from './model/runtime-status-controller'
import { TranscriptController } from './model/transcript-controller'
import { reduceTranscriptBatch } from './model/transcript-reducer'
import { TranscriptViewportController } from './model/transcript-viewport-controller'
import { ToolTranscriptProjector } from './presentation/tools'
import { attachAgent, type AgentAttachmentRequest } from './runtime/agent-attachment'
import { createRuntimePlugin } from './runtime/cordis-runtime'
import { InputController } from './runtime/input-controller'
import { InteractionScheduler } from './runtime/interaction-scheduler'
import { doctorExitCode, formatDoctorReport, runDoctor } from './runtime/doctor'
import { requestExitUntilHonoured } from './runtime/exit-request'
import { readPipedPrompt } from './runtime/print-runner'
import { startPrintRuntime } from './runtime/print-runtime'
import { PreferencesStore, TUI_SETTINGS_NAMESPACE } from './runtime/preferences-store'
import { ResourceOwner } from './runtime/resource-owner'
import { SessionAttachmentCoordinator } from './runtime/session-attachment-coordinator'
import { exportRawSession } from './runtime/session-export'
import { WorkspaceCompletionProvider } from './runtime/workspace-completion-provider'
import { detectTerminalCapabilities } from './ui/terminal-links'
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
  const jobs = ctx.get('jobs')
  const settings = ctx.get('settings')
  const subagentRuntime = ctx.get('subagents')
  const skillRegistry = ctx.get('skills')
  const attachmentStore = ctx.get('attachments')
  // Negotiated once, before anything is rendered.
  const terminalCapabilities = detectTerminalCapabilities()
  const sessionProjections = ctx.get('sessionProjections')
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
    // The schema is what a configuration surface renders; the cross-field rules
    // a schema cannot express (chord syntax, keymap collisions) stay in
    // `validate`, so an unusable document is refused at the write.
    const settingsScope = settings === undefined
      ? undefined
      : (() => {
          try {
            return settings.register(
              settingsNamespace(TUI_SETTINGS_NAMESPACE),
              z.object({
                keymap: z.dict(z.string()).default({}),
                reducedMotion: z.boolean().default(false),
                screenReader: z.boolean().default(false),
                theme: z.union(['default', 'high-contrast', 'no-color'] as const)
                  .default('default'),
              }),
              { applies: 'live', validate: value => void resolvePreferences(value) },
            )
          } catch (error) {
            diagnostics.report(error)
            return undefined
          }
        })()
    // Persistence is capability-gated: without a writable settings provider the
    // store stays process-only and says so rather than dropping edits at exit.
    const preferencesStore = new PreferencesStore({
      controller: preferences,
      reportError: diagnostics.report,
      ...(settingsScope === undefined ? {} : { scope: settingsScope }),
      writable: settings?.writable === true,
    })
    owner.own('preferences store', () => preferencesStore.dispose())
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
        const jobsPanel = new JobsController(attachment.agent, jobs, {
          reportError: diagnostics.report,
        })
        bindingOwner.own('jobs controller', () => jobsPanel.dispose())
        const subagentAttachments = new AbortController()
        bindingOwner.own('subagent attachment requests', () => subagentAttachments.abort())
        const subagents = new SubagentTreeController(attachment.agent, subagentRuntime, {
          // Attachment stays owned by the coordinator; this panel only names a target.
          attach: (childId) => {
            const activeCoordinator = coordinatorRef.current
            if (activeCoordinator === undefined) {
              throw new Error('Session transition coordinator is not ready')
            }
            if (activeCoordinator.getSnapshot().status !== 'attached') {
              throw new Error('Another session transition is already running')
            }
            void activeCoordinator
              .switchSession(String(childId), subagentAttachments.signal)
              .catch(diagnostics.report)
          },
          reportError: diagnostics.report,
        })
        bindingOwner.own('subagent tree controller', () => subagents.dispose())
        const projections = new ProjectionHubController(
          attachment.agent.session,
          sessionProjections,
          { reportError: diagnostics.report },
        )
        bindingOwner.own('projection hub controller', () => projections.dispose())
        const activity = new ActivityCenterController(
          { jobs: jobsPanel, projections, subagents },
          { reportError: diagnostics.report },
        )
        bindingOwner.own('activity center controller', () => activity.dispose())
        // `@deepseek-ai/dsh-host-plugin-inventory` exposes the Loader projection
        // as a Typert *remote* gateway and declares no Cordis context service,
        // so an in-process consumer has no public way to reach it on rc.6. The
        // controller is constructed without a source: the panel reports the
        // capability as absent rather than reading Loader internals, and it
        // gains a real inventory as soon as a public in-process seam exists.
        const plugins = new PluginInventoryController(undefined, undefined, {
          reportError: diagnostics.report,
        })
        bindingOwner.own('plugin inventory controller', () => plugins.dispose())
        const mcp = new McpInventoryController(
          { schemas: () => tools.schemas(attachment.agent) },
          // A reconnect re-registers the server's tools, so the registry's own
          // change event is what makes a stale inventory visible.
          listener => ctx.on('tools/change', listener),
          { reportError: diagnostics.report },
        )
        bindingOwner.own('mcp inventory controller', () => mcp.dispose())
        const skills = new SkillsController(attachment.agent, skillRegistry, {
          cwd: dependencies.cwd,
          reportError: diagnostics.report,
        })
        bindingOwner.own('skills controller', () => skills.dispose())
        const attachments = new AttachmentsController(attachmentStore, {
          inlineImages: terminalCapabilities.inlineImages,
          reportError: diagnostics.report,
        })
        bindingOwner.own('attachments controller', () => attachments.dispose())
        const editor = new EditorController()
        bindingOwner.own('editor controller', () => editor.dispose())
        const workspaceRoot = attachment.agent.session.header.cwd ?? dependencies.cwd()
        const input = new InputController({
          agent: attachment.agent,
          commands,
          references: {
            ...(attachmentStore === undefined
              ? {}
              : {
                  attachImage: async (path: string) => {
                    const outcome = await attachments.attach(
                      path,
                      async candidate => new Uint8Array(await readFile(candidate)),
                    )
                    if (outcome !== 'attached') throw new Error('the attachment store refused it')
                    const staged = attachments.getSnapshot().rows.at(-1)
                    return staged?.attachmentId ?? ''
                  },
                }),
            readFile: async (path: string) => new Uint8Array(await readFile(path)),
            // Reuse the same containment rule the path completion enforces.
            resolveInWorkspace: (candidate: string) => {
              const absolute = resolve(workspaceRoot, candidate)
              const inside = relative(workspaceRoot, absolute)
              return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
                ? absolute
                : undefined
            },
          },
        })
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
            activity,
            attachments,
            readFile: async (path: string) => new Uint8Array(await readFile(path)),
            terminalCapabilities,
            jobs: jobsPanel,
            mcp,
            plugins,
            palette,
            permission,
            preferences,
            projections,
            recovery,
            sessionId,
            runtimeStatus,
            skills,
            subagents,
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
    // A first run has no persisted session to resume, which is the one signal
    // available before the user has done anything.
    let firstRun = false
    try {
      firstRun = (await sessionPersistence.list(AbortSignal.timeout(2_000))).length === 0
    } catch (error) {
      // Onboarding guidance is not worth failing startup over.
      diagnostics.report(error)
    }
    const application = dependencies.mountApplication({
      firstRun,
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
    // --print is checked before the interactive runtime so a non-interactive
    // run never requires a TTY it will not use.
    // --doctor is read-only: it starts no session and runs no agent, so it is
    // checked before both runtimes and before the TTY requirement.
    if (startup.doctor === true) return runDoctorCommand(ctx, startup)
    if (startup.print === true) return startPrintRun(ctx, startup, signal)
    return startTuiRuntime(ctx, startup, signal)
  },
})


const DOCTOR_SERVICE_KEYS: readonly string[] = [
  'agents',
  'agentDefaultModel',
  'commands',
  'jobs',
  'llm',
  'permissionPresets',
  'sessionPersistence',
  'sessionProjections',
  'sessions',
  'settings',
  'skills',
  'subagents',
  'tools',
  'userQuestions',
]

/**
 * Read-only environment diagnosis. It resolves service handles and asks
 * persistence whether it can list, but starts no session, creates no agent, and
 * executes no tool — a diagnostic that changed what it diagnosed would be worse
 * than none.
 */
async function runDoctorCommand(
  ctx: Context,
  startup: TuiStartupValues,
  dependencies: RuntimeDependencies = defaultDependencies,
): Promise<() => Promise<void>> {
  const services = DOCTOR_SERVICE_KEYS.filter(key => ctx.get(key as never) !== undefined)
  const sessionPersistence = ctx.get('sessionPersistence')
  let persistence: { listable: boolean, reason?: string } | undefined
  if (sessionPersistence !== undefined) {
    // A wedged backend must not hang the diagnosis that would explain it.
    const timeout = AbortSignal.timeout(5_000)
    try {
      await sessionPersistence.list(timeout)
      persistence = { listable: true }
    } catch (error) {
      persistence = {
        listable: false,
        reason: timeout.aborted
          ? 'Listing persisted sessions timed out after 5s.'
          : diagnosticMessage(error),
      }
    }
  }
  const report = runDoctor({
    colorDisabled: process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '',
    // Names only; a doctor report is the kind of output users paste into issues.
    envNames: Object.keys(process.env),
    ...(startup.model === undefined ? {} : { model: startup.model }),
    ...(persistence === undefined ? {} : { persistence }),
    services,
    stdinIsTty: dependencies.stdin.isTTY === true,
    stdoutIsTty: dependencies.stdout.isTTY === true,
  })
  process.stdout.write(formatDoctorReport(report))
  const stopExitRequests = requestExitUntilHonoured(ctx.get('appExit'), doctorExitCode(report))
  return () => {
    stopExitRequests()
    return Promise.resolve()
  }
  return () => Promise.resolve()
}

/**
 * Non-interactive entry. It mounts no terminal state, so it runs on a pipe, in
 * CI, and without a controlling terminal — but it still needs a prompt, which
 * comes from the argument or from stdin.
 */
async function startPrintRun(
  ctx: Context,
  startup: TuiStartupValues,
  signal: AbortSignal,
  dependencies: RuntimeDependencies = defaultDependencies,
): Promise<() => Promise<void>> {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) throw new Error('dsh-tui requires the launcher appExit service')
  const prompt = startup.prompt
    ?? (dependencies.stdin.isTTY === true
      ? undefined
      : await readPipedPrompt(process.stdin))
  if (prompt === undefined) {
    process.stderr.write('dsh-tui --print requires a prompt argument or piped stdin\n')
    const stopPromptExit = requestExitUntilHonoured(appExit, 2)
    return () => {
      stopPromptExit()
      return Promise.resolve()
    }
    return () => Promise.resolve()
  }
  const result = await startPrintRuntime(ctx, {
    format: startup.outputFormat ?? 'text',
    prompt,
    request: requestFor(startup, dependencies),
    sessionId: startup.resumeSessionId ?? dependencies.sessionId(),
    signal,
    streams: { stderr: process.stderr, stdout: process.stdout },
  })
  const stopExitRequests = requestExitUntilHonoured(appExit, result.exitCode)
  return () => {
    stopExitRequests()
    return Promise.resolve()
  }
  return () => Promise.resolve()
}

export function apply(ctx: Context): ReturnType<typeof runtimePlugin.apply> {
  return runtimePlugin.apply(ctx, undefined)
}
