import { describe, expect, it, vi } from 'vitest'

import type { TranscriptListener, TranscriptStore } from './transcript-controller'
import { createTranscriptState, type TranscriptState } from './transcript-reducer'
import {
  projectTranscriptPlainText,
  TranscriptViewportController,
} from './transcript-viewport-controller'
import type { TranscriptRow } from './view-model'

function row(id: string, content = id): TranscriptRow {
  return { content, id, kind: 'assistant' }
}

function toolRow(id: string, lines: readonly string[]): TranscriptRow {
  return {
    content: `raw ${id}`,
    id,
    kind: 'tool',
    toolCard: { card: 'terminal', lines, title: `Tool ${id}` },
  }
}

function transcriptState(rows: readonly TranscriptRow[], droppedRows = 0): TranscriptState {
  return Object.freeze({
    ...createTranscriptState({ maxRows: Math.max(1, rows.length) }),
    droppedRows,
    rows: Object.freeze([...rows]),
  })
}

class FixtureTranscriptStore implements TranscriptStore {
  readonly #listeners = new Set<TranscriptListener>()
  #snapshot: TranscriptState

  constructor(rows: readonly TranscriptRow[], droppedRows = 0) {
    this.#snapshot = transcriptState(rows, droppedRows)
  }

  getSnapshot = () => this.#snapshot

  subscribe = (listener: TranscriptListener) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  update(rows: readonly TranscriptRow[], droppedRows = this.#snapshot.droppedRows): void {
    this.#snapshot = transcriptState(rows, droppedRows)
    for (const listener of this.#listeners) void listener()
  }

  get listenerCount(): number {
    return this.#listeners.size
  }
}

describe('TranscriptViewportController (M1.2)', () => {
  it('follows the tail, preserves a detached row, and counts unseen/evicted rows', () => {
    const store = new FixtureTranscriptStore(Array.from({ length: 5 }, (_, index) => row(`row-${index}`)))
    const viewport = new TranscriptViewportController(store)

    expect(viewport.getSnapshot()).toMatchObject({ followTail: true, scrollOffset: 0, unseenRows: 0 })
    expect(viewport.scrollLines(2)).toBe(true)
    expect(viewport.getSnapshot()).toMatchObject({
      focusedRowId: 'row-2',
      followTail: false,
      scrollOffset: 2,
    })

    store.update(Array.from({ length: 6 }, (_, index) => row(`row-${index}`)))
    expect(viewport.getSnapshot()).toMatchObject({
      focusedRowId: 'row-2',
      scrollOffset: 3,
      unseenRows: 1,
    })

    store.update(Array.from({ length: 6 }, (_, index) => row(`row-${index + 1}`)), 1)
    expect(viewport.getSnapshot()).toMatchObject({
      evictedWhileDetached: 1,
      focusedRowId: 'row-2',
      historyTruncated: true,
      scrollOffset: 4,
      unseenRows: 2,
    })

    expect(viewport.toEnd()).toBe(true)
    expect(viewport.getSnapshot()).toMatchObject({
      evictedWhileDetached: 0,
      followTail: true,
      scrollOffset: 0,
      unseenRows: 0,
    })
    expect(viewport.getSnapshot().focusedRowId).toBeUndefined()
    viewport.dispose()
  })

  it('supports row/page/start/end navigation with safe clamping', () => {
    const store = new FixtureTranscriptStore(Array.from({ length: 10 }, (_, index) => row(`row-${index}`)))
    const viewport = new TranscriptViewportController(store)

    expect(viewport.scrollPage('up', 4)).toBe(true)
    expect(viewport.getSnapshot().scrollOffset).toBe(4)
    expect(viewport.scrollPage('down', 2)).toBe(true)
    expect(viewport.getSnapshot().scrollOffset).toBe(2)
    expect(viewport.toStart()).toBe(true)
    expect(viewport.getSnapshot()).toMatchObject({ focusedRowId: 'row-0', scrollOffset: 9 })
    expect(viewport.scrollLines(100)).toBe(false)
    expect(viewport.toEnd()).toBe(true)
    expect(viewport.scrollLines(-1)).toBe(false)

    viewport.dispose()
  })

  it('searches retained content and tool details with bounded newest matches', () => {
    const store = new FixtureTranscriptStore([
      row('old', 'Alpha old'),
      toolRow('tool', ['ALPHA detail']),
      row('other', 'beta'),
    ])
    const viewport = new TranscriptViewportController(store, { maxSearchMatches: 1 })

    viewport.openSearch()
    expect(viewport.insertSearch('alpha')).toBe('applied')
    expect(viewport.getSnapshot().search).toMatchObject({
      activeIndex: 0,
      incomplete: false,
      matchIds: ['tool'],
      open: true,
      query: 'alpha',
      totalMatches: 2,
      truncated: true,
    })
    expect(viewport.getSnapshot()).toMatchObject({ focusedRowId: 'tool', followTail: false })
    expect(viewport.nextMatch()).toBe(true)
    expect(viewport.nextMatch('previous')).toBe(true)
    viewport.closeSearch()
    expect(viewport.getSnapshot().search.open).toBe(false)
    viewport.clearSearch()
    expect(viewport.getSnapshot().search).toMatchObject({ query: '', totalMatches: 0 })

    viewport.dispose()
  })

  it('reports reducer eviction and search-index budget as incomplete', () => {
    const store = new FixtureTranscriptStore([
      row('old', 'needle'),
      row('new', '12345'),
    ], 2)
    const viewport = new TranscriptViewportController(store, {
      maxSearchQueryCodeUnits: 3,
      maxSearchTextCodeUnits: 5,
    })

    viewport.openSearch()
    expect(viewport.insertSearch('need')).toBe('limit-exceeded')
    expect(viewport.insertSearch('nee')).toBe('applied')
    expect(viewport.getSnapshot().search).toMatchObject({
      incomplete: true,
      totalMatches: 0,
    })
    expect(viewport.backspaceSearch()).toBe(true)
    expect(viewport.getSnapshot().search.query).toBe('ne')

    viewport.dispose()
  })

  it('folds individual or all tool details without mutating durable rows', () => {
    const durable = [toolRow('one', ['a', 'b']), row('middle'), toolRow('two', ['x', 'y', 'z'])]
    const store = new FixtureTranscriptStore(durable)
    const viewport = new TranscriptViewportController(store)

    expect(viewport.toggleFocusedTool()).toBe(true)
    const folded = viewport.projectRows(durable)
    expect(folded[2]?.toolCard?.lines).toEqual(['[3 detail lines folded]'])
    expect(durable[2]?.toolCard?.lines).toEqual(['x', 'y', 'z'])
    expect(viewport.toggleFocusedTool()).toBe(true)
    expect(viewport.projectRows(durable)).toEqual(durable)

    viewport.toggleCompactTools()
    expect(viewport.getSnapshot().compactTools).toBe(true)
    expect(viewport.projectRows(durable)[0]?.toolCard?.lines).toEqual(['[2 detail lines folded]'])
    expect(viewport.toggleFocusedTool()).toBe(true)
    expect(viewport.projectRows(durable)[2]?.toolCard?.lines).toEqual(['x', 'y', 'z'])

    viewport.dispose()
  })

  it('pages every line of a focused expanded tool within a bounded card', () => {
    const durable = [toolRow('long', ['one', 'two', 'three', 'four', 'five'])]
    const store = new FixtureTranscriptStore(durable)
    const viewport = new TranscriptViewportController(store)

    expect(viewport.projectRows(durable, { maxToolDetailLines: 3 })[0]?.toolCard?.lines)
      .toEqual(['one', 'two', '[3 later detail lines · Alt+PageDown]'])
    expect(viewport.scrollFocusedTool('down', 2)).toBe(true)
    expect(viewport.projectRows(durable, { maxToolDetailLines: 3 })[0]?.toolCard?.lines)
      .toEqual([
        '[2 earlier detail lines · Alt+PageUp]',
        'three',
        '[2 later detail lines · Alt+PageDown]',
      ])
    expect(viewport.scrollFocusedTool('down', 10)).toBe(true)
    expect(viewport.projectRows(durable, { maxToolDetailLines: 3 })[0]?.toolCard?.lines)
      .toEqual(['[4 earlier detail lines · Alt+PageUp]', 'five'])
    expect(viewport.scrollFocusedTool('up', 10)).toBe(true)
    expect(viewport.projectRows(durable, { maxToolDetailLines: 3 })[0]?.toolCard?.lines?.[0]).toBe('one')
    expect(() => viewport.projectRows(durable, { maxToolDetailLines: 0 })).toThrow('maxToolDetailLines')

    viewport.dispose()
  })

  it('reserves the bounded card budget for an upstream truncation marker', () => {
    const durable: readonly TranscriptRow[] = [{
      content: 'raw truncated',
      id: 'truncated',
      kind: 'tool',
      toolCard: {
        card: 'terminal',
        lines: ['one', 'two', 'three'],
        title: 'Tool truncated',
        truncated: true,
      },
    }]
    const viewport = new TranscriptViewportController(new FixtureTranscriptStore(durable))

    expect(viewport.projectRows(durable, { maxToolDetailLines: 3 })[0]?.toolCard?.lines)
      .toEqual(['one', '[2 later detail lines · Alt+PageDown]'])

    viewport.dispose()
  })

  it('produces bounded decoration-free transcript text', () => {
    const rows = [
      { content: 'question', id: 'u', kind: 'user' } as const,
      toolRow('run', ['$ pnpm test', 'passed']),
    ]
    expect(projectTranscriptPlainText(rows)).toEqual({
      text: 'User: question\n\nTool: Tool run\n  $ pnpm test\n  passed',
      truncated: false,
    })
    const bounded = projectTranscriptPlainText(rows, 35)
    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toHaveLength(35)
    expect(bounded.text).toContain('truncated')
    expect(() => projectTranscriptPlainText(rows, 0)).toThrow('maximumCodeUnits')
  })

  it('publishes stable snapshots and unregisters quiescently', () => {
    const store = new FixtureTranscriptStore([row('one')])
    const viewport = new TranscriptViewportController(store)
    const listener = vi.fn()
    viewport.subscribe(listener)
    const initial = viewport.getSnapshot()

    viewport.openSearch()
    expect(listener).toHaveBeenCalledOnce()
    expect(viewport.getSnapshot()).not.toBe(initial)
    expect(viewport.getSnapshot()).toBe(viewport.getSnapshot())
    expect(store.listenerCount).toBe(1)
    viewport.dispose()
    viewport.dispose()
    expect(store.listenerCount).toBe(0)
    store.update([row('one'), row('two')])
    expect(listener).toHaveBeenCalledOnce()
    expect(() => viewport.toEnd()).toThrow('disposed')
  })

  it('validates controller limits', () => {
    const store = new FixtureTranscriptStore([])
    expect(() => new TranscriptViewportController(store, { maxSearchMatches: 0 })).toThrow('maxSearchMatches')
    expect(() => new TranscriptViewportController(store, { maxSearchQueryCodeUnits: 0 })).toThrow('maxSearchQueryCodeUnits')
    expect(() => new TranscriptViewportController(store, { maxSearchTextCodeUnits: 0 })).toThrow('maxSearchTextCodeUnits')
    expect(() => new TranscriptViewportController(store, { maxToolOverrides: 0 })).toThrow('maxToolOverrides')
  })
})
