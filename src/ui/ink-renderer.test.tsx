import { describe, expect, it } from 'vitest'

import { createScreenModel, type TranscriptRow } from '../model/view-model'
import { renderInkFrame } from './ink-renderer'

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
})
