import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import type { AgentStatusStore } from '../model/agent-status-controller'
import { ChangeIndexController } from '../model/change-index-controller'
import { CommandPaletteController } from '../model/command-palette-controller'
import { CompletionController } from '../model/completion-controller'
import { EditorController } from '../model/editor-controller'
import { InteractionController } from '../model/interaction-controller'
import { OverlayController } from '../model/overlay-controller'
import { PreferencesController } from '../model/preferences-controller'
import { PermissionController } from '../model/permission-controller'
import { ActivityCenterController } from '../model/activity-center-controller'
import { JobsController } from '../model/jobs-controller'
import { AttachmentsController } from '../model/attachments-controller'
import { McpInventoryController } from '../model/mcp-inventory-controller'
import { PluginInventoryController } from '../model/plugin-inventory-controller'
import { SkillsController } from '../model/skills-controller'
import { SubagentTreeController } from '../model/subagent-tree-controller'
import { ProjectionHubController } from '../model/projection-hub-controller'
import { RecoveryController } from '../model/recovery-controller'
import { SessionCenterController } from '../model/session-center-controller'
import { RuntimeStatusController } from '../model/runtime-status-controller'
import { TranscriptController } from '../model/transcript-controller'
import { TranscriptViewportController } from '../model/transcript-viewport-controller'
import type { InputController } from '../runtime/input-controller'
import { InteractiveTui } from './app'

const status: AgentStatusStore = {
  getSnapshot: () => 'idle',
  subscribe: () => () => undefined,
}

function fakeInput(): InputController {
  return {
    cancelAgent: () => undefined,
    cancelCommand: () => false,
    commandPending: false,
    submit: async () => ({
      code: 'empty',
      kind: 'rejected',
      message: 'Input must not be empty',
    }),
  } as unknown as InputController
}

function renderApp(
  transcript: TranscriptController,
  interaction: InteractionController,
  configure?: (
    viewport: TranscriptViewportController,
    overlay: OverlayController,
    palette: CommandPaletteController,
    changes: ChangeIndexController,
  ) => void,
  initialNotice?: string,
) {
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
      fork: async () => ({ boundary: 0, sessionId: 'forked-session' }),
    },
    sessionId: 'session-app',
    suggestedExportDestination: 'session-app.jsonl',
  })
  const completion = new CompletionController({ complete: async () => [] })
  const sessionCenter = new SessionCenterController({
    inspect: async () => { throw new Error('not configured') },
    list: async () => [],
  }, {
    switchSession: async () => undefined,
  }, { currentSessionId: 'session-app' })
  const runtimeStatus = new RuntimeStatusController({ model: 'model', provider: 'fixture' })
  try {
    configure?.(viewport, overlay, palette, changes)
    return renderToString(
      <InteractiveTui
        changes={changes}
        columns={52}
        completion={completion}
        editor={editor}
        input={fakeInput()}
        {...(initialNotice === undefined ? {} : { initialNotice })}
        interaction={interaction}
        modelLabel="fixture/model"
        onQuit={() => undefined}
        overlay={overlay}
        palette={palette}
        // renderToString models no viewport: it does not clip, it overwrites,
        // so a fixed height garbles the output here while a real terminal
        // renders it correctly. These snapshots assert content; screen geometry
        // is asserted in screen.pty.test.ts, against a live PTY.
        renderMode="inline"
        preferences={preferences}
        activity={activity}
        jobs={jobs}
        attachments={attachments}
        mcp={mcp}
        plugins={plugins}
        skills={skills}
        subagents={subagents}
        projections={projections}
        recovery={recovery}
        permission={permission}
        sessionId="session-app"
        sessionCenter={sessionCenter}
        runtimeStatus={runtimeStatus}
        status={status}
        terminalRows={14}
        transcript={transcript}
        viewport={viewport}
        workspace="/fixture/workspace"
      />,
      { columns: 52 },
    )
  } finally {
    void completion.dispose()
    changes.dispose()
    void sessionCenter.dispose()
    runtimeStatus.dispose()
    permission.dispose()
    activity.dispose()
  jobs.dispose()
  attachments.dispose()
  mcp.dispose()
  plugins.dispose()
  skills.dispose()
  subagents.dispose()
    projections.dispose()
    void recovery.dispose()
    palette.dispose()
    overlay.dispose()
    viewport.dispose()
    editor.dispose()
  }
}

describe('InteractiveTui', () => {
  it('renders the bounded composer chrome', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()

    expect(renderApp(transcript, interaction)).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────────────────╮
      │ dsh-tui v0.6.0                                   │
      │ fixture/model                                    │
      │ /fixture/workspace                               │
      │                                                  │
      │ Getting started                                  │
      │ ^P  command palette — every action is here       │
      │ ^Y  activity · ^B jobs · ^G subagents            │
      │ /exit  quit with a durable teardown              │
      ╰──────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────╮
      │ ›  Try "explain this repository" · ^P for the c… │
      ╰──────────────────────────────────────────────────╯
      dsh-tui · session-app · idle · fixture/model
      transcript empty
      Enter send · ^J newline · ^S steer · ^C cancel"
    `)

    interaction.dispose()
    await transcript.dispose()
  })

  it('surfaces a recovered session-switch failure on the reattached application', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()

    expect(renderApp(
      transcript,
      interaction,
      undefined,
      'Target session failed; restored session-app.',
    )).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────────────────╮
      │ dsh-tui v0.6.0                                   │
      │ fixture/model                                    │
      │ /fixture/workspace                               │
      │                                                  │
      │ Getting started                                  │
      │ ^P  command palette — every action is here       │
      │ ^Y  activity · ^B jobs · ^G subagents            │
      │ /exit  quit with a durable teardown              │
      ╰──────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────╮
      │ ›  Try "explain this repository" · ^P for the c… │
      ╰──────────────────────────────────────────────────╯
      dsh-tui · session-app · idle · fixture/model
      transcript empty
      Target session failed; restored session-app."
    `)

    interaction.dispose()
    await transcript.dispose()
  })

  it('renders an explicit fail-closed approval choice', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const pending = interaction.askApproval({
      agent: { id: 'root-agent' } as unknown as Agent,
      reason: 'outside sandbox',
      toolName: 'bash',
    }, abort.signal)

    expect(renderApp(transcript, interaction)).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────────────────╮
      │ dsh-tui v0.6.0                                   │
      │ fixture/model                                    │
      │ /fixture/workspace                               │
      │                                                  │
      │ Getting started                                  │
      │ ^P  command palette — every action is here       │
      │ ^Y  activity · ^B jobs · ^G subagents            │
      │ /exit  quit with a durable teardown              │
      ╰──────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────╮
      │ Approval · agent root-agent                      │
      │ bash                                             │
      │ outside sandbox                                  │
      │ Y allow once · N reject                          │
      ╰──────────────────────────────────────────────────╯
      ╭──────────────────────────────────────────────────╮
      │ ›  Try "explain this repository" · ^P for the c… │
      ╰──────────────────────────────────────────────────╯
      dsh-tui · session-app · idle · fixture/model
      transcript empty
      Enter send · ^J newline · ^S steer · ^C cancel"
    `)

    abort.abort(new Error('done'))
    await expect(pending).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })

  it('adds exact planned file context to a matching approval only', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const pending = interaction.askApproval({
      agent: { id: 'root-agent' } as unknown as Agent,
      callId: 'write-call' as never,
      reason: 'write file',
      toolName: 'write',
    }, abort.signal)

    const rendered = renderApp(transcript, interaction, (_viewport, _overlay, _palette, changes) => {
      changes.record({
        callId: 'write-call',
        diffs: [{ newText: 'new', oldText: 'old', path: 'src/app.ts' }],
        eventSeq: 1,
        phase: 'planned',
        rowId: 'tool:write-call',
        title: 'Edit app',
      })
    })
    expect(rendered).toContain('Planned changes (1):')
    expect(rendered).toContain('src/app.ts')

    abort.abort(new Error('done'))
    await expect(pending).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })

  it('renders question cursor, multi-select controls, and Other affordance', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const pending = interaction.askQuestions({
      agent: { id: 'root-agent' } as unknown as Agent,
      questions: [{
        header: 'Scope',
        id: 'scope',
        multiSelect: true,
        options: [{ label: 'Tests' }, { description: 'Update docs', label: 'Docs' }],
        question: 'What should be included?',
      }],
    }, abort.signal)

    expect(renderApp(transcript, interaction)).toContain('> [ ] Tests')
    expect(renderApp(transcript, interaction)).toContain('Tab: Other · Enter: answer')

    abort.abort(new Error('done'))
    await expect(pending).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })

  it('renders transcript search as an exclusive focus row without discarding the composer', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()

    expect(renderApp(transcript, interaction, (viewport) => {
      viewport.openSearch()
      viewport.insertSearch('needle')
    })).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────────────────╮
      │ dsh-tui v0.6.0                                   │
      │ fixture/model                                    │
      │ /fixture/workspace                               │
      │                                                  │
      │ Getting started                                  │
      │ ^P  command palette — every action is here       │
      │ ^Y  activity · ^B jobs · ^G subagents            │
      │ /exit  quit with a durable teardown              │
      ╰──────────────────────────────────────────────────╯
      / needle█ · 0/0
      ╭──────────────────────────────────────────────────╮
      │ ›  Try "explain this repository" · ^P for the c… │
      ╰──────────────────────────────────────────────────╯
      dsh-tui · session-app · idle · fixture/model
      transcript empty
      Enter send · ^J newline · ^S steer · ^C cancel"
    `)

    interaction.dispose()
    await transcript.dispose()
  })

  it('renders a narrow command palette as a full-screen exclusive overlay', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()

    expect(renderApp(transcript, interaction, (_viewport, overlay, palette) => {
      palette.insertQuery('rev')
      overlay.open('command-palette')
    })).toMatchSnapshot()

    interaction.dispose()
    await transcript.dispose()
  })

  it('visually suspends an existing overlay while an interaction owns focus', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const pending = interaction.askApproval({
      agent: { id: 'exact-agent' } as unknown as Agent,
      reason: 'confirm',
      toolName: 'fixture',
    }, abort.signal)

    const rendered = renderApp(transcript, interaction, (_viewport, overlay) => {
      overlay.open('command-palette')
    })
    expect(rendered).toContain('Approval · agent exact-agent')
    expect(rendered).not.toContain('Command palette')

    abort.abort(new Error('done'))
    await expect(pending).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })
})
