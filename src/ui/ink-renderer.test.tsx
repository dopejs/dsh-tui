import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { TranscriptController } from '../model/transcript-controller'
import { createScreenModel, type TranscriptRow } from '../model/view-model'
import { renderInkFrame, TranscriptFrame } from './ink-renderer'

type MessageId = SessionEvent<'assistant/message'>['data']['message']['id']

describe('renderInkFrame', () => {
  it('renders deterministic mixed-width output and agent-scoped interaction', () => {
    const rows: TranscriptRow[] = [
      { content: 'hello', id: '1', kind: 'user' },
      { content: '寬字 e\u0301 emoji 👩🏽‍💻', id: '2', kind: 'assistant' },
      { content: 'pnpm test', id: '3', kind: 'tool' },
    ]
    const model = createScreenModel(
      rows,
      {
        sessionId: 'spike-session',
        status: 'busy',
        terminalRows: 12,
      },
      { agentLabel: 'root', message: 'Allow command?', title: 'Approval' },
    )

    expect(renderInkFrame(model, 48)).toMatchInlineSnapshot(`
      "dsh-tui · spike-session · busy
      transcript 1–3 of 3
      U hello
      A 寬字 é emoji 👩🏽‍💻
      T pnpm test
      ╭──────────────────────────────────────────────╮
      │ Approval · agent root                        │
      │ Allow command?                               │
      ╰──────────────────────────────────────────────╯"
    `)
  })

  it('renders bounded transcript state with visible lifecycle status', async () => {
    const controller = new TranscriptController()
    controller.accept([{
      data: {
        chunk: { index: 0, text: 'working', type: 'text-delta' },
        step: 0,
        turn: 0,
      },
      seq: 0,
      time: 0,
      type: 'assistant/chunk',
    }])

    expect(renderInkFrame(
      createScreenModel(controller.getSnapshot().rows, {
        sessionId: 'live-session',
        status: 'busy',
        terminalRows: 8,
      }),
      48,
    )).toMatchInlineSnapshot(`
      "dsh-tui · live-session · busy
      transcript 1–1 of 1
      A working [streaming]"
    `)

    expect(
      renderInkFrame(
        createScreenModel(controller.getSnapshot().rows, {
          sessionId: 'live-session',
          status: 'busy',
          terminalRows: 8,
        }),
        48,
      ),
    ).toBe(
      renderInkFrame(
        createScreenModel(controller.getSnapshot().rows, {
          sessionId: 'live-session',
          status: 'busy',
          terminalRows: 8,
        }),
        48,
      ),
    )

    expect(renderToString(
      <TranscriptFrame
        columns={48}
        controller={controller}
        sessionId="live-session"
        status="busy"
        terminalRows={8}
      />,
      { columns: 48 },
    )).toContain('A working [streaming]')

    controller.accept([{
      data: {
        message: {
          content: [{ text: 'done', type: 'text' }],
          id: 'assistant-final' as MessageId,
          role: 'assistant',
          source: { kind: 'model', model: 'fixture', provider: 'fixture' },
        },
        step: 0,
        turn: 0,
      },
      seq: 1,
      time: 1,
      type: 'assistant/message',
    }])
    expect(renderToString(
      <TranscriptFrame
        columns={48}
        controller={controller}
        sessionId="live-session"
        status="idle"
        terminalRows={8}
      />,
      { columns: 48 },
    )).toMatchInlineSnapshot(`
      "dsh-tui · live-session · idle
      transcript 1–1 of 1
      A done"
    `)
    await controller.dispose()
  })
})
