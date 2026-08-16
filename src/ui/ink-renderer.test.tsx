import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { TranscriptController } from '../model/transcript-controller'
import { InteractionController } from '../model/interaction-controller'
import { createScreenModel, type TranscriptRow } from '../model/view-model'
import { renderInkFrame, TranscriptFrame } from './ink-renderer'

type MessageId = SessionEvent<'assistant/message'>['data']['message']['id']

describe('renderInkFrame', () => {
  it.each([40, 80, 120])('degrades status metadata deterministically at %i columns', (columns) => {
    const model = createScreenModel([], {
      approvalPolicy: 'ask',
      contextWindow: 128_000,
      modelLabel: 'provider/model',
      permissionPreset: 'workspace-write',
      sessionId: 'status-session',
      status: 'idle',
      terminalRows: 8,
      totalTokens: 1_234,
      workspace: '/very/long/workspace/path',
    })

    expect(renderInkFrame(model, columns)).toMatchSnapshot()
  })

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

  it('renders a fixed-size structured terminal card', () => {
    const model = createScreenModel([{
      content: 'raw fallback',
      id: 'tool-card',
      kind: 'tool',
      status: 'complete',
      toolCard: {
        card: 'terminal',
        lines: ['$ pnpm test', 'all tests passed', 'exit: 0'],
        title: 'Run tests',
      },
    }], {
      sessionId: 'tool-session',
      status: 'idle',
      terminalRows: 10,
    })

    expect(renderInkFrame(model, 44)).toMatchInlineSnapshot(`
      "dsh-tui · tool-session · idle
      transcript 1–1 of 1
      T Run tests
        $ pnpm test
        all tests passed
        exit: 0"
    `)
  })

  it('renders viewport focus, eviction, unseen state, and a folded tool card', () => {
    const model = createScreenModel([{
      content: 'raw',
      id: 'folded-tool',
      kind: 'tool',
      toolCard: {
        card: 'terminal',
        lines: ['[12 detail lines folded]'],
        title: 'Run suite',
      },
    }], {
      droppedRows: 7,
      focusedRowId: 'folded-tool',
      sessionId: 'viewport-session',
      status: 'busy',
      terminalRows: 8,
      unseenRows: 3,
    })

    expect(renderInkFrame(model, 48)).toMatchInlineSnapshot(`
      "dsh-tui · viewport-session · busy
      transcript 1–1 of 1 · 7 evicted · 3 new
      › T Run suite
        [12 detail lines folded]"
    `)
  })

  it('renders an agent-labelled plan review from the interaction store', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const answering = interaction.askQuestions({
      agent: { id: 'root-agent' } as unknown as Agent,
      questions: [{
        detail: '# Ship safely',
        header: 'Plan',
        id: 'review',
        intent: { approve: 'Approve', kind: 'plan-review' },
        options: [{ label: 'Approve' }, { label: 'Revise' }],
        question: 'Proceed?',
      }],
    }, abort.signal)

    expect(renderToString(
      <TranscriptFrame
        columns={48}
        controller={transcript}
        interaction={interaction}
        sessionId="review-session"
        status="idle"
        terminalRows={12}
      />,
      { columns: 48 },
    )).toMatchInlineSnapshot(`
      "dsh-tui · review-session · idle
      transcript empty
      ╭──────────────────────────────────────────────╮
      │ Plan review · agent root-agent               │
      │ Plan                                         │
      │ Proceed?                                     │
      │ # Ship safely                                │
      │ [ ] Approve                                  │
      │ [ ] Revise                                   │
      ╰──────────────────────────────────────────────╯"
    `)
    abort.abort(new Error('done'))
    await expect(answering).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })
})
