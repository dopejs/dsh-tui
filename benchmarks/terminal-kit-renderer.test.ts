import { describe, expect, it } from 'vitest'

import { createScreenModel, type TranscriptRow } from '../src/model/view-model.js'
import { renderTerminalKitFrame } from './terminal-kit-renderer.js'

describe('renderTerminalKitFrame', () => {
  it('renders a deterministic mixed-width candidate frame', () => {
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

    const frame = renderTerminalKitFrame(model, 48, 12)
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd()

    expect(frame).toMatchSnapshot()
  })
})
