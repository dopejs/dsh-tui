import { describe, expect, it } from 'vitest'

import type { CommandPaletteSnapshot } from '../model/command-palette-controller'
import type { CompletionSnapshot } from '../model/completion-controller'
import type { SessionCenterSnapshot } from '../model/session-center-controller'
import type { PermissionSnapshot } from '../model/permission-controller'
import { renderOverlayPanel } from './overlay'

const emptyCompletion: CompletionSnapshot = {
  items: [],
  query: '',
  revision: 0,
  status: 'idle',
  truncated: false,
}

const emptySessions: SessionCenterSnapshot = {
  catalogTruncated: false,
  items: [],
  query: '',
  revision: 0,
  status: 'idle',
  totalMatches: 0,
}

const emptyPermissions: PermissionSnapshot = {
  confirmationText: '',
  items: [],
  revision: 0,
  status: 'unavailable',
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
      permissions: emptyPermissions,
      sessions: emptySessions,
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
      permissions: emptyPermissions,
      sessions: emptySessions,
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
      permissions: emptyPermissions,
      sessions: emptySessions,
    })).toMatchSnapshot()
  })

  it('renders a bounded session list and durable preview metadata', () => {
    const palette: CommandPaletteSnapshot = {
      catalogTruncated: false,
      items: [],
      query: '',
      revision: 0,
      totalMatches: 0,
    }
    const sessions: SessionCenterSnapshot = {
      catalogTruncated: false,
      items: [{
        createdAt: 1_700_000_000_000,
        cwd: '/workspace',
        id: 'current-session',
        isCurrent: true,
      }, {
        createdAt: 1_699_000_000_000,
        id: 'older-session',
        isCurrent: false,
      }],
      preview: {
        eventCount: 42,
        id: 'current-session',
        lastEventType: 'turn/end',
      },
      query: 'session',
      revision: 3,
      selectedIndex: 0,
      status: 'ready',
      totalMatches: 2,
    }

    expect(renderOverlayPanel({
      active: 'session-center',
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
      permissions: emptyPermissions,
      sessions,
    })).toMatchSnapshot()
  })

  it('renders permission consequences and dangerous typed confirmation', () => {
    const palette: CommandPaletteSnapshot = {
      catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
    }
    const permissions: PermissionSnapshot = {
      confirmationPhrase: 'enable danger-full-access',
      confirmationTarget: 'danger-full-access',
      confirmationText: 'enable danger',
      items: [{
        approval: 'never',
        dangerous: true,
        name: 'Danger full access',
        sandbox: 'danger-full-access',
        selected: false,
        value: 'danger-full-access',
      }],
      revision: 2,
      status: 'confirming',
      truncated: false,
    }
    expect(renderOverlayPanel({
      active: 'permissions',
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
      permissions,
      sessions: emptySessions,
    })).toMatchSnapshot()

    expect(renderOverlayPanel({
      active: 'permissions',
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
      permissions: {
        confirmationText: '',
        items: [{
          approval: 'ask',
          dangerous: false,
          description: 'Confine writes to the workspace and ask when needed.',
          name: 'Workspace write',
          sandbox: 'workspace-write',
          selected: true,
          value: 'workspace-write',
        }, {
          approval: 'never',
          dangerous: true,
          name: 'Danger full access',
          sandbox: 'danger-full-access',
          selected: false,
          value: 'danger-full-access',
        }],
        revision: 1,
        selectedIndex: 0,
        status: 'ready',
        truncated: false,
      },
      sessions: emptySessions,
    })).toMatchSnapshot()
  })
})
