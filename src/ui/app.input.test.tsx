import { PassThrough } from 'node:stream'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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
import { McpInventoryController } from '../model/mcp-inventory-controller'
import { PluginInventoryController } from '../model/plugin-inventory-controller'
import { SkillsController } from '../model/skills-controller'
import { SubagentTreeController } from '../model/subagent-tree-controller'
import { ProjectionHubController } from '../model/projection-hub-controller'
import { RecoveryController } from '../model/recovery-controller'
import { SessionCenterController } from '../model/session-center-controller'
import { RuntimeStatusController } from '../model/runtime-status-controller'
import { TranscriptController } from '../model/transcript-controller'
import { createTranscriptState, type TranscriptState } from '../model/transcript-reducer'
import { TranscriptViewportController } from '../model/transcript-viewport-controller'
import type { TranscriptRow } from '../model/view-model'
import type { InputController, InputSubmission } from '../runtime/input-controller'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { InteractiveTui } from './app'

class FixtureStdin extends PassThrough {
  isRaw = false
  readonly isTTY = true

  ref(): this {
    return this
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }

  unref(): this {
    return this
  }
}

class FixtureStdout extends PassThrough {
  readonly columns = 60
  readonly isTTY = true
  readonly rows = 18
}

const status: AgentStatusStore = {
  getSnapshot: () => 'idle',
  subscribe: () => () => undefined,
}

async function eventually(assertion: () => void): Promise<void> {
  let error: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion()
      return
    } catch (caught) {
      error = caught
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  throw error
}

function eventForPreview(): SessionEvent {
  return { data: {}, seq: 0, time: 0, type: 'session/start' } as SessionEvent
}

describe('InteractiveTui input (M1.1–M1.3)', () => {
  it('edits multiline input, batches bracketed paste, submits once, and restores terminal modes', async () => {
    const stdin = new FixtureStdin()
    const stdout = new FixtureStdout()
    let output = ''
    stdout.on('data', chunk => { output += String(chunk) })
    const editor = new EditorController()
    const changes = new ChangeIndexController()
    changes.record({
      callId: 'input-change',
      diffs: [{ newText: 'new', oldText: 'old', path: 'src/controller.ts' }],
      eventSeq: 1,
      phase: 'applied',
      rowId: 'tool-row',
      title: 'Edit controller',
    })
    const interaction = new InteractionController()
    const durableRows: readonly TranscriptRow[] = Object.freeze([
      ...Array.from({ length: 20 }, (_, index): TranscriptRow => Object.freeze({
        content: index === 4 ? 'needle in retained history' : `message ${String(index)}`,
        id: `row-${String(index)}`,
        kind: 'assistant',
      })),
      Object.freeze({
        content: 'raw tool result',
        id: 'tool-row',
        kind: 'tool',
        toolCard: Object.freeze({
          card: 'terminal',
          lines: Object.freeze(['one', 'two', 'three']),
          title: 'Test tool',
        }),
      }),
    ])
    const seededTranscript: TranscriptState = Object.freeze({
      ...createTranscriptState({ maxRows: durableRows.length }),
      rows: durableRows,
    })
    const transcript = new TranscriptController({ projectBatch: () => seededTranscript })
    transcript.accept([])
    const viewport = new TranscriptViewportController(transcript)
    const overlay = new OverlayController()
    const palette = new CommandPaletteController({
      list: () => [
        { description: 'Fail for testing', name: 'fail' },
        { description: 'Fixture command', name: 'fixture' },
        { description: 'Review a path', input: { hint: '<path>' }, name: 'review' },
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
    const activity = new ActivityCenterController({ jobs, projections, subagents })
    const recovery = new RecoveryController({
      operations: {
        flush: async () => true,
        fork: async () => ({ boundary: 0, sessionId: 'forked-session' }),
      },
      sessionId: 'input-session',
      suggestedExportDestination: 'input-session.jsonl',
    })
    const completion = new CompletionController({
      complete: async request => request.kind === 'command'
        ? [{
            description: 'Review a path',
            id: 'command:review',
            label: '/review',
            replacement: '/review ',
          }]
        : [{
            description: 'file',
            id: 'path:src/controller.ts',
            label: 'src/controller.ts',
            replacement: 'src/controller.ts',
          }],
    })
    const switchSession = vi.fn(async () => undefined)
    const sessionCenter = new SessionCenterController({
      inspect: async id => ({
        events: [eventForPreview()],
        meta: { createdAt: 1, id, version: 0 },
      }),
      list: async () => [{
        createdAt: 2,
        id: SessionId('input-session'),
        version: 0,
      }, {
        createdAt: 1,
        id: SessionId('other-session'),
        version: 0,
      }],
    }, { switchSession }, { currentSessionId: 'input-session' })
    const runtimeStatus = new RuntimeStatusController({ model: 'model', provider: 'fixture' })
    const submissionFailure = new Error('message queue unavailable')
    const submit = vi.fn(async (text: string): Promise<InputSubmission> => {
      if (text === '/fail') {
        return {
          execution: {
            result: { kind: 'error', text: 'fixture command failed' },
          } as never,
          kind: 'command',
        }
      }
      if (text === 'retain failed draft') {
        return {
          error: submissionFailure,
          kind: 'message-error',
          message: submissionFailure.message,
          mode: 'followup',
        }
      }
      return {
          kind: 'message',
          message: { text } as never,
          mode: 'followup',
      }
    })
    let commandPending = false
    const cancelCommand = vi.fn(() => {
      if (!commandPending) return false
      commandPending = false
      return true
    })
    const input = {
      cancelAgent: vi.fn(),
      cancelCommand,
      get commandPending() { return commandPending },
      submit,
    } as unknown as InputController

    const mounted = render(
      <InteractiveTui
        changes={changes}
        completion={completion}
        editor={editor}
        input={input}
        interaction={interaction}
        modelLabel="fixture/model"
        onQuit={() => undefined}
        overlay={overlay}
        palette={palette}
        preferences={preferences}
        activity={activity}
        jobs={jobs}
        mcp={mcp}
        plugins={plugins}
        skills={skills}
        subagents={subagents}
        projections={projections}
        recovery={recovery}
        permission={permission}
        sessionId="input-session"
        sessionCenter={sessionCenter}
        runtimeStatus={runtimeStatus}
        status={status}
        transcript={transcript}
        viewport={viewport}
        workspace="/fixture"
      />,
      {
        exitOnCtrlC: false,
        interactive: true,
        maxFps: 1_000,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    try {
      await mounted.waitUntilRenderFlush()
      await eventually(() => expect(output).toContain('\u001B[?2004h'))

      stdin.write('hello')
      stdin.write('\n')
      stdin.write('world')
      stdin.write('\u001B[200~\r\npasted\r\nblock\u001B[201~')
      await eventually(() => {
        expect(editor.getSnapshot().text).toBe('hello\nworld\npasted\nblock')
      })

      // Move before the final character, delete it, then restore it through undo.
      stdin.write('\u001B[D')
      stdin.write('\u007F')
      await eventually(() => expect(editor.getSnapshot().text).toBe('hello\nworld\npasted\nblok'))
      stdin.write('\u001A')
      await eventually(() => expect(editor.getSnapshot().text).toBe('hello\nworld\npasted\nblock'))

      stdin.write('\r')
      await eventually(() => expect(submit).toHaveBeenCalledTimes(1))
      expect(submit).toHaveBeenCalledWith('hello\nworld\npasted\nblock', 'followup')
      await eventually(() => expect(editor.getSnapshot().text).toBe(''))

      // Accepted submissions enter bounded history and can be recalled.
      stdin.write('\u001B[A')
      await eventually(() => expect(editor.getSnapshot().text).toBe('hello\nworld\npasted\nblock'))

      // Search exclusively owns input while open and leaves the composer draft intact.
      stdin.write('\u001B[102;5u')
      stdin.write('needle')
      await eventually(() => expect(viewport.getSnapshot().search).toMatchObject({
        open: true,
        query: 'needle',
      }))
      expect(editor.getSnapshot().text).toBe('hello\nworld\npasted\nblock')
      stdin.write('\u001B[27u')
      await eventually(() => expect(viewport.getSnapshot().search.open).toBe(false))

      const searchOffset = viewport.getSnapshot().scrollOffset
      stdin.write('\u001B[5~')
      await eventually(() => expect(viewport.getSnapshot().scrollOffset).toBeGreaterThan(searchOffset))
      stdin.write('\u001B[1;5F')
      await eventually(() => expect(viewport.getSnapshot()).toMatchObject({
        followTail: true,
        scrollOffset: 0,
      }))

      stdin.write('\u001B[116;5u')
      await eventually(() => {
        expect(viewport.projectRows(durableRows).at(-1)?.toolCard?.lines)
          .toEqual(['[3 detail lines folded]'])
      })

      stdin.write('\u001B[99;6u')
      await eventually(() => expect(output).toContain('\u001B]52;c;'))

      stdin.write('\u0003')
      await eventually(() => expect(editor.getSnapshot().text).toBe(''))

      stdin.write('retain failed draft')
      await eventually(() => expect(editor.getSnapshot().text).toBe('retain failed draft'))
      stdin.write('\r')
      await eventually(() => expect(submit).toHaveBeenCalledTimes(2))
      await eventually(() => expect(output).toContain('message queue unavailable'))
      expect(editor.getSnapshot().text).toBe('retain failed draft')
      stdin.write('\u0003')
      await eventually(() => expect(editor.getSnapshot().text).toBe(''))

      stdin.write('\u001B[111;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('session-center'))
      await eventually(() => expect(sessionCenter.getSnapshot()).toMatchObject({
        status: 'ready',
        totalMatches: 2,
      }))
      stdin.write('\u001B[B')
      await eventually(() => expect(sessionCenter.selected()?.id).toBe('other-session'))
      stdin.write(' ')
      await eventually(() => expect(sessionCenter.getSnapshot().preview).toMatchObject({
        eventCount: 1,
        id: 'other-session',
      }))
      stdin.write('\r')
      await eventually(() => expect(switchSession).toHaveBeenCalledWith(
        'other-session',
        expect.any(AbortSignal),
      ))
      await eventually(() => expect(sessionCenter.selected()?.isCurrent).toBe(true))
      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('fixture')
      await eventually(() => expect(palette.getSnapshot().query).toBe('fixture'))
      stdin.write('\r')
      await eventually(() => expect(submit).toHaveBeenCalledTimes(3))
      expect(submit).toHaveBeenLastCalledWith('/fixture', 'followup')
      expect(overlay.getSnapshot().active).toBeUndefined()
      await eventually(() => expect(editor.getSnapshot().text).toBe(''))

      stdin.write('/rev')
      await eventually(() => expect(editor.getSnapshot().text).toBe('/rev'))
      stdin.write('\t')
      await eventually(() => expect(completion.getSnapshot()).toMatchObject({
        status: 'ready',
      }))
      expect(overlay.getSnapshot().active).toBe('completion')
      stdin.write('\r')
      await eventually(() => expect(editor.getSnapshot().text).toBe('/review '))
      stdin.write('src/controller.ts')
      await eventually(() => expect(editor.getSnapshot().text).toBe('/review src/controller.ts'))
      stdin.write('\r')
      await eventually(() => expect(submit).toHaveBeenCalledTimes(4))
      expect(submit).toHaveBeenLastCalledWith('/review src/controller.ts', 'followup')
      await eventually(() => expect(editor.getSnapshot().text).toBe(''))

      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('open changes')
      await eventually(() => expect(palette.getSnapshot().query).toBe('open changes'))
      stdin.write('\r')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('changes'))
      stdin.write('\r')
      await eventually(() => expect(changes.selected()?.expanded).toBe(true))
      stdin.write('j')
      await eventually(() => expect(overlay.getSnapshot().active).toBeUndefined())
      expect(viewport.getSnapshot().focusedRowId).toBe('tool-row')

      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('open projections')
      await eventually(() => expect(palette.getSnapshot().query).toBe('open projections'))
      stdin.write('\r')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('projections'))
      await eventually(() => expect(output).toContain('plan projection unavailable'))
      stdin.write('r')
      await eventually(() => expect(output).toContain('Projection registry is unavailable'))
      stdin.write('\u001B[27u')
      await eventually(() => expect(overlay.getSnapshot().active).toBeUndefined())

      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('open activity')
      await eventually(() => expect(palette.getSnapshot().query).toBe('open activity'))
      stdin.write('\r')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('activity'))
      // Nothing is pending, so the center says so instead of implying a failure.
      await eventually(() => expect(output).toContain('Nothing pending'))
      stdin.write('c')
      await eventually(() => expect(output).toContain('Nothing pending.'))
      stdin.write('\u001B[27u')
      await eventually(() => expect(overlay.getSnapshot().active).toBeUndefined())

      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('open jobs')
      await eventually(() => expect(palette.getSnapshot().query).toBe('open jobs'))
      stdin.write('\r')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('jobs'))
      // Without a registry the panel states the boundary instead of an empty list.
      await eventually(() => expect(output).toContain('Jobs · unavailable'))
      await eventually(() => expect(output).toContain('Output stays with the agent'))
      stdin.write('k')
      await eventually(() => expect(output).toContain('Only a live job owned by this session'))
      stdin.write('r')
      await eventually(() => expect(output).toContain('The job registry is unavailable'))
      stdin.write('\u001B[27u')
      await eventually(() => expect(overlay.getSnapshot().active).toBeUndefined())

      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('open recovery')
      await eventually(() => expect(palette.getSnapshot().query).toBe('open recovery'))
      stdin.write('\r')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('recovery'))
      stdin.write('\r')
      await eventually(() => expect(recovery.getSnapshot().status).toBe('success'))
      stdin.write('\u001B[B\u001B[B')
      await eventually(() => expect(recovery.getSnapshot().selectedIndex).toBe(2))
      stdin.write('\r')
      await eventually(() => expect(recovery.getSnapshot().status).toBe('confirming-fork'))
      stdin.write('\u001B[27u')
      await eventually(() => expect(recovery.getSnapshot().status).toBe('idle'))
      expect(recovery.getSnapshot().capabilities[3]).toMatchObject({
        available: false,
        id: 'file-rewind',
      })
      stdin.write('\u001B[27u')
      await eventually(() => expect(overlay.getSnapshot().active).toBeUndefined())

      stdin.write('\u001B[112;5u')
      await eventually(() => expect(overlay.getSnapshot().active).toBe('command-palette'))
      stdin.write('fail')
      await eventually(() => expect(palette.getSnapshot().query).toBe('fail'))
      stdin.write('\r')
      await eventually(() => expect(submit).toHaveBeenCalledTimes(5))
      await eventually(() => expect(output).toContain('fixture command failed'))
      expect(editor.getSnapshot().text).toBe('/fail')

      commandPending = true
      stdin.write('\u0003')
      await eventually(() => expect(cancelCommand).toHaveBeenCalledOnce())
      expect(editor.getSnapshot().text).toBe('/fail')
      stdin.write('\u0003')
      await eventually(() => expect(editor.getSnapshot().text).toBe(''))
    } finally {
      mounted.unmount()
      await mounted.waitUntilExit()
      interaction.dispose()
      await completion.dispose()
      await sessionCenter.dispose()
      runtimeStatus.dispose()
      permission.dispose()
      activity.dispose()
    jobs.dispose()
    mcp.dispose()
    plugins.dispose()
    skills.dispose()
    subagents.dispose()
      projections.dispose()
      await recovery.dispose()
      palette.dispose()
      overlay.dispose()
      viewport.dispose()
      await transcript.dispose()
      editor.dispose()
      changes.dispose()
    }
    expect(stdin.isRaw).toBe(false)
    expect(output).toContain('\u001B[?2004l')
  })
})
