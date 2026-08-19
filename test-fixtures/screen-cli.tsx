/**
 * The real interface, in a real terminal.
 *
 * Every interface defect this project shipped -- an invisible caret, a reply
 * glued to the model's scratch work, the working line in the wrong region --
 * survived a suite that renders through `renderToString`. That helper produces
 * text, not a screen: it does not take the alternate screen, does not place a
 * cursor, does not overwrite cells, and cannot show what inversion looks like
 * against a background. This fixture mounts the same `InteractiveTui` under a
 * PTY so a test can read the screen the way a user sees it.
 *
 * It is a fixture, not a product entry point: controllers are inert stand-ins,
 * and the transcript is seeded from a named scenario so runs are deterministic.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountInkApplication, probeTerminalKeyboard } from '../src/ui/ink-app-runtime'

import type { AgentStatusStore } from '../src/model/agent-status-controller'
import { ActivityCenterController } from '../src/model/activity-center-controller'
import { AttachmentsController } from '../src/model/attachments-controller'
import { ChangeIndexController } from '../src/model/change-index-controller'
import { CommandPaletteController } from '../src/model/command-palette-controller'
import { CompletionController } from '../src/model/completion-controller'
import { EditorController } from '../src/model/editor-controller'
import { InteractionController } from '../src/model/interaction-controller'
import { JobsController } from '../src/model/jobs-controller'
import { McpInventoryController } from '../src/model/mcp-inventory-controller'
import { OverlayController } from '../src/model/overlay-controller'
import { PermissionController } from '../src/model/permission-controller'
import { PluginInventoryController } from '../src/model/plugin-inventory-controller'
import { PreferencesController } from '../src/model/preferences-controller'
import { ProjectionHubController } from '../src/model/projection-hub-controller'
import { RecoveryController } from '../src/model/recovery-controller'
import { RuntimeStatusController } from '../src/model/runtime-status-controller'
import { SessionCenterController } from '../src/model/session-center-controller'
import { SkillsController } from '../src/model/skills-controller'
import { SubagentTreeController } from '../src/model/subagent-tree-controller'
import { TranscriptController } from '../src/model/transcript-controller'
import { TranscriptViewportController } from '../src/model/transcript-viewport-controller'
import type { InputController } from '../src/runtime/input-controller'
import { ModelCatalogController } from '../src/model/model-catalog-controller'
import type { InteractiveTuiProps } from '../src/ui/app'

const scenario = process.argv[2] ?? 'empty'

const status: AgentStatusStore = {
  getSnapshot: () => 'idle',
  subscribe: () => () => undefined,
}

const input = {
  cancelAgent: () => undefined,
  cancelCommand: () => false,
  commandPending: false,
  submit: async () => ({ kind: 'accepted' as const }),
} as unknown as InputController

/**
 * `time` is separate from `seq` on purpose: the reducer requires contiguous
 * sequence numbers, while durations are read from the clock. Deriving one from
 * the other makes a four-second thought unrepresentable without a sequence gap.
 */
function event(seq: number, type: string, data: unknown, time = seq) {
  return { data, seq, time, type } as never
}

/** A turn shaped like the one that exposed the reply-swallowing defect. */
function conversation() {
  return [
    event(0, 'user/message', {
      content: [{ text: 'hello', type: 'text' }],
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
    }),
    event(1, 'user/message', {
      content: [{
        text: `<system-reminder>\n${Array.from({ length: 40 }, (_, i) => `reminder ${String(i)}`).join('\n')}`,
        type: 'text',
      }],
      id: 'u2',
      role: 'user',
      source: { kind: 'inject' },
    }),
    // Streamed the way a real turn arrives, so the reasoning duration is
    // measured from the durable event times rather than assumed.
    event(2, 'assistant/chunk', {
      chunk: { blockType: 'reasoning', index: 0, type: 'block-start' },
      step: 1,
      turn: 1,
    }),
    event(3, 'assistant/chunk', {
      chunk: {
        block: { text: 'The user said hello. Answer briefly.', type: 'reasoning' },
        index: 0,
        type: 'block-end',
      },
      step: 1,
      turn: 1,
    }, 4_200),
    event(4, 'assistant/message', {
      message: {
        content: [
          { text: 'The user said hello. Answer briefly.', type: 'reasoning' },
          {
            text: 'Hi! I am in the doper workspace.\n\nWhat would you like to work on?',
            type: 'text',
          },
        ],
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', model: 'fixture', provider: 'fixture' },
      },
      step: 1,
      turn: 1,
    }),
  ]
}

/** More turns than any terminal can show, to exercise clipping. */
function overflowing() {
  return Array.from({ length: 60 }, (_, index) => event(index, 'user/message', {
    content: [{ text: `turn ${String(index)} of a long conversation`, type: 'text' }],
    id: `u${String(index)}`,
    role: 'user',
    source: { kind: 'user' },
  }))
}

const transcript = new TranscriptController()
if (scenario === 'conversation') transcript.accept(conversation())
if (scenario === 'overflow') transcript.accept(overflowing())

const editor = new EditorController()
const changes = new ChangeIndexController()
const viewport = new TranscriptViewportController(transcript)
const overlay = new OverlayController()
const palette = new CommandPaletteController({
  list: () => [
    { description: 'Review changes', name: 'review' },
    // Declares an argument, which is what Tab exists for.
    { description: 'Start a session on a model', inputHint: 'provider/model', name: 'model' },
  ],
  subscribe: () => () => undefined,
})
const preferences = new PreferencesController()
const permission = new PermissionController({} as Agent)
const projections = new ProjectionHubController({} as Agent['session'])
const jobs = new JobsController({} as Agent)
const subagents = new SubagentTreeController({} as Agent)
const skills = new SkillsController()
const mcp = new McpInventoryController()
const plugins = new PluginInventoryController()
const attachments = new AttachmentsController()
const activity = new ActivityCenterController({ jobs, projections, subagents })
const recovery = new RecoveryController({
  operations: {
    flush: async () => true,
    fork: async () => ({ boundary: 0, sessionId: 'forked' }),
  },
  sessionId: 'session-screen',
  suggestedExportDestination: 'session-screen.jsonl',
})
const completion = new CompletionController({ complete: async () => [] })
const sessionCenter = new SessionCenterController(
  { inspect: async () => { throw new Error('not configured') }, list: async () => [] },
  { switchSession: async () => undefined },
  { currentSessionId: 'session-screen' },
)
const runtimeStatus = new RuntimeStatusController({ model: 'model', provider: 'fixture' })
const interaction = new InteractionController()
const modelCatalog = new ModelCatalogController({
  listModels: async provider => provider === 'ark'
    ? [{ id: 'deepseek-v4-pro' }, { id: 'glm-5.3' }]
    : [{ id: 'deepseek-v4-flash' }],
  listProviders: () => [
    { id: 'ark', name: 'Ark' },
    { id: 'deepseek-official', name: 'DeepSeek' },
  ],
})
if (scenario === 'models') {
  modelCatalog.requestPicker()
  void modelCatalog.load()
}

/*
 * Mounted through `mountInkApplication`, the same entry point the plugin uses.
 *
 * Mounting `InteractiveTui` directly left the mouse plumbing -- asking the
 * terminal to report, filtering the reports out of Ink's input, and stopping on
 * the way out -- outside everything the screen tests exercise. Removing the
 * filter kept them green.
 */
const application: Omit<InteractiveTuiProps, 'onQuit' | 'sessionCenter'> = {
  activity,
  attachments,
  changes,
  completion,
  editor,
  input,
  interaction,
  jobs,
  mcp,
  modelLabel: 'fixture/model',
  models: modelCatalog,
  overlay,
  palette,
  permission,
  plugins,
  preferences,
  projections,
  recovery,
  runtimeStatus,
  sessionId: 'session-screen',
  skills,
  status,
  subagents,
  transcript,
  viewport,
  // Answers the way a machine with nothing on its clipboard does, so the
  // key's feedback path is exercised without a real clipboard.
  readClipboardImage: async () => ({ kind: 'empty' as const }),
  workspace: '/fixture/workspace',
}

const snapshot = {
  binding: { application, sessionId: 'session-screen' },
  revision: 0,
  status: 'attached',
} as never

// Disposed before exiting, because that is what stops the terminal reporting.
// Exiting straight from `onQuit` leaves the terminal printing escape sequences
// into the user's shell on every click afterwards.
// The same order the plugin uses: ask the terminal first, mount second.
const keyboard = await probeTerminalKeyboard()

const mounted = mountInkApplication({
  kittyKeyboard: keyboard.kittyKeyboard,
  ...(keyboard.mouse === undefined ? {} : { mouse: keyboard.mouse }),
  onQuit: () => {
    /*
     * A stalled teardown is reported, not waited on forever.
     *
     * When this hung it hung silently, and three CI rounds went into guessing
     * which handle was holding the loop open. Exiting with a distinct code
     * keeps the test red while naming what is still alive.
     */
    const watchdog = setTimeout(() => {
      process.stderr.write(
        `[fixture] teardown stalled; active: ${JSON.stringify(process.getActiveResourcesInfo())}\n`,
      )
      process.exit(97)
    }, 5_000)
    void mounted.dispose().then(
      () => {
        clearTimeout(watchdog)
        process.exit(0)
      },
      (error: unknown) => {
        clearTimeout(watchdog)
        process.stderr.write(`[fixture] teardown failed: ${String(error)}\n`)
        process.exit(1)
      },
    )
  },
  sessionCenter,
  sessions: { getSnapshot: () => snapshot, subscribe: () => () => undefined },
})
