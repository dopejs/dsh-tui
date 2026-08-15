import { describe, expect, it } from 'vitest'

import { createScreenModel, type TranscriptRow } from './view-model.js'

const rows: TranscriptRow[] = Array.from({ length: 10_000 }, (_, index) => ({
  content: `row ${index}`,
  id: `row-${index}`,
  kind: 'assistant',
}))

describe('createScreenModel', () => {
  it('materializes only the visible transcript window', () => {
    const model = createScreenModel(rows, {
      sessionId: 'session-1',
      status: 'idle',
      terminalRows: 40,
    })

    expect(model.totalRows).toBe(10_000)
    expect(model.rows).toHaveLength(37)
    expect(model.rows[0]?.id).toBe('row-9963')
    expect(model.rows.at(-1)?.id).toBe('row-9999')
    expect(model.visibleRange).toEqual({ end: 10_000, start: 9_964 })
  })

  it('reserves space for a modal and supports scrolling', () => {
    const model = createScreenModel(
      rows,
      {
        modalRows: 5,
        scrollOffset: 10,
        sessionId: 'session-1',
        status: 'busy',
        terminalRows: 20,
      },
      { agentLabel: 'root', message: 'Proceed?', title: 'Approval' },
    )

    expect(model.rows).toHaveLength(12)
    expect(model.rows.at(-1)?.id).toBe('row-9989')
    expect(model.modal?.agentLabel).toBe('root')
    expect(model.visibleRange).toEqual({ end: 9_990, start: 9_979 })
  })
})
