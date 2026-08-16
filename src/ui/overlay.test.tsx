import { describe, expect, it } from 'vitest'

import type { CommandPaletteSnapshot } from '../model/command-palette-controller'
import type { CompletionSnapshot } from '../model/completion-controller'
import { renderOverlayPanel } from './overlay'

const emptyCompletion: CompletionSnapshot = {
  items: [],
  query: '',
  revision: 0,
  status: 'idle',
  truncated: false,
}

describe('OverlayPanel (M1.3)', () => {
  it('renders a bounded narrow command palette', () => {
    const palette: CommandPaletteSnapshot = {
      catalogTruncated: true,
      items: Array.from({ length: 8 }, (_, index) => ({
        description: `Description ${String(index)}`,
        id: `command:${String(index)}`,
        kind: 'command',
        label: `/command-${String(index)}`,
        name: `command-${String(index)}`,
      })),
      query: 'com',
      revision: 1,
      selectedIndex: 5,
      totalMatches: 8,
    }

    expect(renderOverlayPanel({
      active: 'command-palette',
      columns: 40,
      completion: emptyCompletion,
      maxRows: 9,
      palette,
    })).toMatchSnapshot()
  })

  it('renders command/path completion states', () => {
    const palette: CommandPaletteSnapshot = {
      catalogTruncated: false,
      items: [],
      query: '',
      revision: 0,
      totalMatches: 0,
    }
    const completion: CompletionSnapshot = {
      items: [{
        description: 'file',
        end: 16,
        id: 'path:src/controller.ts',
        kind: 'path',
        label: 'src/controller.ts',
        replacement: 'src/controller.ts',
        start: 6,
      }],
      kind: 'path',
      query: 'src/co',
      revision: 2,
      selectedIndex: 0,
      status: 'ready',
      truncated: false,
    }

    expect(renderOverlayPanel({
      active: 'completion',
      columns: 60,
      completion,
      maxRows: 8,
      palette,
    })).toMatchSnapshot()
  })

  it('renders a wide command palette without losing input metadata', () => {
    const palette: CommandPaletteSnapshot = {
      catalogTruncated: false,
      items: [{
        description: 'Review current workspace changes before committing',
        id: 'command:review',
        inputHint: '<path>',
        kind: 'command',
        label: '/review',
        name: 'review',
      }, {
        action: 'transcript.search',
        description: 'Search the retained transcript window',
        id: 'action:transcript.search',
        kind: 'action',
        label: 'Search transcript',
      }],
      query: '',
      revision: 1,
      selectedIndex: 0,
      totalMatches: 2,
    }

    expect(renderOverlayPanel({
      active: 'command-palette',
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
    })).toMatchSnapshot()
  })
})
