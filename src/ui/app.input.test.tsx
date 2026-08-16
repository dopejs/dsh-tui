import { PassThrough } from 'node:stream'
import type { AgentStatusStore } from '../model/agent-status-controller'
import { EditorController } from '../model/editor-controller'
import { InteractionController } from '../model/interaction-controller'
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

describe('InteractiveTui input (M1.1–M1.2)', () => {
  it('edits multiline input, batches bracketed paste, submits once, and restores terminal modes', async () => {
    const stdin = new FixtureStdin()
    const stdout = new FixtureStdout()
    let output = ''
    stdout.on('data', chunk => { output += String(chunk) })
    const editor = new EditorController()
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
    const submit = vi.fn(async (text: string): Promise<InputSubmission> => ({
      kind: 'message',
      message: { text } as never,
      mode: 'followup',
    }))
    const input = {
      cancelAgent: vi.fn(),
      cancelCommand: vi.fn(() => false),
      commandPending: false,
      submit,
    } as unknown as InputController

    const mounted = render(
      <InteractiveTui
        editor={editor}
        input={input}
        interaction={interaction}
        modelLabel="fixture/model"
        onQuit={() => undefined}
        sessionId="input-session"
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
    } finally {
      mounted.unmount()
      await mounted.waitUntilExit()
      interaction.dispose()
      viewport.dispose()
      await transcript.dispose()
      editor.dispose()
    }
    expect(stdin.isRaw).toBe(false)
    expect(output).toContain('\u001B[?2004l')
  })
})
