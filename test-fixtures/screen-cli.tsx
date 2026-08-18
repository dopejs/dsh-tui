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
import { render } from 'ink'

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
import { InteractiveTui } from '../src/ui/app'

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

function event(seq: number, type: string, data: unknown) {
  return { data, seq, time: seq, type } as never
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
    event(2, 'assistant/message', {
      message: {
        content: [
          { text: 'The user said hello. Answer briefly.', type: 'reasoning' },
          { text: 'Hi! How can I help you with doper today?', type: 'text' },
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
  list: () => [{ description: 'Review changes', name: 'review' }],
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

render(
  <InteractiveTui
    activity={activity}
    attachments={attachments}
    changes={changes}
    completion={completion}
    editor={editor}
    input={input}
    interaction={interaction}
    jobs={jobs}
    mcp={mcp}
    modelLabel="fixture/model"
    onQuit={() => process.exit(0)}
    overlay={overlay}
    palette={palette}
    permission={permission}
    plugins={plugins}
    preferences={preferences}
    projections={projections}
    recovery={recovery}
    runtimeStatus={runtimeStatus}
    sessionCenter={sessionCenter}
    sessionId="session-screen"
    skills={skills}
    status={status}
    subagents={subagents}
    transcript={transcript}
    viewport={viewport}
    workspace="/fixture/workspace"
  />,
  { alternateScreen: true, exitOnCtrlC: false, incrementalRendering: true, interactive: true, maxFps: 20 },
)
