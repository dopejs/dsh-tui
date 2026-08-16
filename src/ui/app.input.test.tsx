import { PassThrough } from 'node:stream'
import type { AgentStatusStore } from '../model/agent-status-controller'
import { EditorController } from '../model/editor-controller'
import { InteractionController } from '../model/interaction-controller'
import { TranscriptController } from '../model/transcript-controller'
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

describe('InteractiveTui input (M1.1)', () => {
  it('edits multiline input, batches bracketed paste, submits once, and restores terminal modes', async () => {
    const stdin = new FixtureStdin()
    const stdout = new FixtureStdout()
    let output = ''
    stdout.on('data', chunk => { output += String(chunk) })
    const editor = new EditorController()
    const interaction = new InteractionController()
    const transcript = new TranscriptController()
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
    } finally {
      mounted.unmount()
      await mounted.waitUntilExit()
      interaction.dispose()
      await transcript.dispose()
      editor.dispose()
    }
    expect(stdin.isRaw).toBe(false)
    expect(output).toContain('\u001B[?2004l')
  })
})
