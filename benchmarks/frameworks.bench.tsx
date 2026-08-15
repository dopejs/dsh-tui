import { bench, describe } from 'vitest'

import {
  createScreenModel,
  type ScreenModel,
  type TranscriptRow,
} from '../src/model/view-model.js'
import { renderInkFrame } from '../src/ui/ink-renderer.js'
import { renderTerminalKitFrame } from './terminal-kit-renderer.js'

const COLUMNS = 100
const TERMINAL_ROWS = 40
const transcript: TranscriptRow[] = Array.from({ length: 10_000 }, (_, index) => ({
  content: `row ${index}: 寬字 e\u0301 👩🏽‍💻 ${'output '.repeat(10)}`,
  id: `row-${index}`,
  kind: index % 5 === 0 ? 'tool' : 'assistant',
}))
const modal = {
  agentLabel: 'root',
  message: 'Run the requested command in this workspace?',
  title: 'Approval',
} as const
const model = createScreenModel(
  transcript,
  {
    sessionId: 'spike-session',
    status: 'busy',
    terminalRows: TERMINAL_ROWS,
  },
  modal,
)

function withChunk(frame: ScreenModel, index: number): ScreenModel {
  const rows = frame.rows.slice()
  const last = rows.at(-1)
  if (last !== undefined) {
    rows[rows.length - 1] = { ...last, content: `${last.content} chunk-${index}` }
  }
  return { ...frame, rows }
}

describe('10,000-row bounded transcript at 100x40', () => {
  bench('Ink 7.1.1 static frame', () => {
    renderInkFrame(model, COLUMNS)
  })

  bench('Terminal Kit 3.1.4 static frame', () => {
    renderTerminalKitFrame(model, COLUMNS, TERMINAL_ROWS)
  })
})

describe('twenty assistant chunk frames', () => {
  bench('Ink 7.1.1 chunk burst', () => {
    for (let index = 0; index < 20; index += 1) {
      renderInkFrame(withChunk(model, index), COLUMNS)
    }
  })

  bench('Terminal Kit 3.1.4 chunk burst', () => {
    for (let index = 0; index < 20; index += 1) {
      renderTerminalKitFrame(withChunk(model, index), COLUMNS, TERMINAL_ROWS)
    }
  })
})
