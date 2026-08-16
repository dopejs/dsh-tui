import { bench, describe } from 'vitest'

import type { TranscriptStore } from '../src/model/transcript-controller'
import type { TranscriptState } from '../src/model/transcript-reducer'
import { TranscriptViewportController } from '../src/model/transcript-viewport-controller'
import type { TranscriptRow } from '../src/model/view-model'

const rows: readonly TranscriptRow[] = Object.freeze(Array.from(
  { length: 10_000 },
  (_, index): TranscriptRow => Object.freeze({
    content: `${String(index).padStart(5, '0')} ${'bounded transcript text '.repeat(8)}${index % 997 === 0 ? 'needle' : ''}`,
    id: `row-${String(index)}`,
    kind: 'assistant',
  }),
))

const state: TranscriptState = Object.freeze({
  droppedRows: 0,
  limits: Object.freeze({ maxRowChars: 20_000, maxRows: 10_000 }),
  nextSeq: 0,
  pendingAssistants: Object.freeze([]),
  pendingTools: Object.freeze([]),
  rows,
})

const store: TranscriptStore = {
  getSnapshot: () => state,
  subscribe: () => () => {},
}

describe('10,000-row bounded transcript viewport', () => {
  bench('searches the bounded two-million-code-unit index', () => {
    const viewport = new TranscriptViewportController(store)
    viewport.openSearch()
    viewport.insertSearch('needle')
    viewport.dispose()
  })

  bench('projects the visible transcript window without copying durable rows', () => {
    const viewport = new TranscriptViewportController(store)
    viewport.projectRows(rows.slice(-100))
    viewport.dispose()
  })
})
