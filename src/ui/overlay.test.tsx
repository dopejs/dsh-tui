import { describe, expect, it } from 'vitest'

import type { CommandPaletteSnapshot } from '../model/command-palette-controller'
import type { ChangeIndexSnapshot } from '../model/change-index-controller'
import type { CompletionSnapshot } from '../model/completion-controller'
import type { JobsSnapshot } from '../model/jobs-controller'
import type { SessionCenterSnapshot } from '../model/session-center-controller'
import type { PermissionSnapshot } from '../model/permission-controller'
import type { ProjectionHubSnapshot } from '../model/projection-hub-controller'
import type { RecoverySnapshot } from '../model/recovery-controller'
import { renderOverlayPanel } from './overlay'

const emptyCompletion: CompletionSnapshot = {
  items: [],
  query: '',
  revision: 0,
  status: 'idle',
  truncated: false,
}

const emptyChanges: ChangeIndexSnapshot = {
  droppedChanges: 0,
  groups: [],
  invalidDiffs: 0,
  revision: 0,
  totalChanges: 0,
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

const emptyRecovery: RecoverySnapshot = {
  capabilities: [],
  destination: '',
  revision: 0,
  selectedIndex: 0,
  sessionId: 'session',
  status: 'idle',
  suggestedExportDestination: 'session.jsonl',
}

describe('OverlayPanel (M1.3)', () => {
  it('renders distinct recovery capabilities and fail-closed fork confirmation', () => {
    const recovery: RecoverySnapshot = {
      capabilities: [{
        available: true,
        detail: 'Await persistence listeners.',
        id: 'durability',
        title: 'Durable session barrier',
      }, {
        available: true,
        detail: 'Raw backend artifact: /sessions/current.jsonl',
        id: 'export',
        title: 'Raw session export',
      }, {
        available: true,
        detail: 'Create a child conversation.',
        id: 'fork',
        title: 'Conversation fork',
      }, {
        available: false,
        detail: 'Unavailable on Harness rc.6: no public file checkpoint owner.',
        id: 'file-rewind',
        title: 'File rewind',
      }],
      destination: '',
      revision: 4,
      selectedIndex: 2,
      sessionId: 'current-session',
      status: 'confirming-fork',
      suggestedExportDestination: 'current-session.jsonl',
    }
    expect(renderOverlayPanel({
      active: 'recovery',
      changes: emptyChanges,
      columns: 72,
      completion: emptyCompletion,
      maxRows: 12,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery,
      sessions: emptySessions,
    })).toMatchSnapshot()

    expect(renderOverlayPanel({
      active: 'recovery',
      changes: emptyChanges,
      columns: 72,
      completion: emptyCompletion,
      maxRows: 12,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: {
        ...recovery,
        destination: 'backup.jsonl',
        selectedIndex: 1,
        status: 'export-input',
      },
      sessions: emptySessions,
    })).toMatchSnapshot()
  })

  it('renders file-grouped change review with bounded expanded detail', () => {
    const first = {
      callId: 'call-a',
      eventSeq: 2,
      expanded: true,
      id: 'call-a:0',
      newText: 'new one\nnew two\nnew three',
      oldText: 'old one\nold two',
      path: 'src/a.ts',
      phase: 'applied' as const,
      rowId: 'tool:call-a',
      title: 'Edit a.ts',
      truncated: false,
    }
    expect(renderOverlayPanel({
      active: 'changes',
      changes: {
        droppedChanges: 3,
        groups: [{
          changes: [first, {
            ...first,
            callId: 'call-b',
            eventSeq: 4,
            expanded: false,
            id: 'call-b:0',
            phase: 'unverified',
            rowId: 'tool:call-b',
            title: 'Edit a.ts again',
          }],
          path: 'src/a.ts',
        }],
        invalidDiffs: 1,
        revision: 3,
        selectedIndex: 0,
        totalChanges: 2,
        truncated: true,
      },
      columns: 64,
      completion: emptyCompletion,
      maxRows: 10,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
    })).toMatchSnapshot()
  })

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
      changes: emptyChanges,
      columns: 40,
      completion: emptyCompletion,
      maxRows: 9,
      palette,
      permissions: emptyPermissions,
      recovery: emptyRecovery,
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
      changes: emptyChanges,
      columns: 60,
      completion,
      maxRows: 8,
      palette,
      permissions: emptyPermissions,
      recovery: emptyRecovery,
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
      changes: emptyChanges,
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
      permissions: emptyPermissions,
      recovery: emptyRecovery,
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
      changes: emptyChanges,
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
      permissions: emptyPermissions,
      recovery: emptyRecovery,
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
      changes: emptyChanges,
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette,
      permissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
    })).toMatchSnapshot()

    expect(renderOverlayPanel({
      active: 'permissions',
      changes: emptyChanges,
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
      recovery: emptyRecovery,
      sessions: emptySessions,
    })).toMatchSnapshot()
  })

  it('renders a bounded projection hub with diagnostics and selected detail', () => {
    const projections: ProjectionHubSnapshot = {
      asOfSeq: 42,
      capabilities: {
        goal: 'available', plan: 'available', todos: 'available', usage: 'available',
      },
      diagnostics: [{ key: 'plugin.custom', kind: 'unknown', summary: '{"state": "ready"}' }],
      droppedDiagnostics: 3,
      droppedTodos: 7,
      revision: 5,
      rows: [{
        id: 'plan:current', label: 'Plan · active', section: 'plan', tone: 'positive',
      }, {
        id: 'todos:0', label: '● Add projection panel', section: 'todos', tone: 'warning',
      }, {
        detail: 'rounds 2/8 · revision 3',
        id: 'goal:current',
        label: 'Goal · active · Ship orchestration',
        section: 'goal',
        tone: 'warning',
      }, {
        detail: 'input 900 · output 100 · cache read 0 · write 0',
        id: 'usage:tokens',
        label: 'Usage · 1000 cumulative tokens',
        section: 'usage',
      }, {
        detail: '{"state": "ready"}',
        id: 'diagnostic:unknown:plugin.custom',
        label: 'Unknown projection · plugin.custom',
        section: 'diagnostics',
        tone: 'warning',
      }],
      selectedIndex: 2,
      status: 'degraded',
    }
    expect(renderOverlayPanel({
      active: 'projections',
      changes: emptyChanges,
      columns: 64,
      completion: emptyCompletion,
      maxRows: 8,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      projections,
      recovery: emptyRecovery,
      sessions: emptySessions,
    })).toMatchSnapshot()
  })

  const jobRows: JobsSnapshot['jobs'] = [{
    id: 'bash-1' as JobsSnapshot['jobs'][number]['id'],
    kind: 'bash',
    label: 'pnpm test --watch',
    owned: true,
    reported: false,
    startedAt: 1,
    status: 'running',
  }, {
    detail: 'exit code: 3',
    finishedAt: 9,
    id: 'bash-2' as JobsSnapshot['jobs'][number]['id'],
    kind: 'bash',
    label: 'pnpm build',
    owned: true,
    reported: true,
    startedAt: 2,
    status: 'failed',
  }, {
    id: 'subagent-1' as JobsSnapshot['jobs'][number]['id'],
    kind: 'subagent',
    label: 'audit the change index',
    owned: false,
    reported: false,
    startedAt: 3,
    status: 'running',
  }]

  function renderJobs(columns: number, overrides: Partial<JobsSnapshot> = {}): string {
    return renderOverlayPanel({
      active: 'jobs',
      changes: emptyChanges,
      columns,
      completion: emptyCompletion,
      jobs: {
        droppedNotices: 0,
        jobs: jobRows,
        notices: [],
        outputCapability: 'unsupported-consuming-read',
        revision: 4,
        runningCount: 2,
        status: 'ready',
        truncated: false,
        ...overrides,
      },
      maxRows: 10,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
    })
  }

  it('renders jobs with ownership, status, and the output boundary at 80 columns', () => {
    expect(renderJobs(80, { selectedIndex: 1 })).toMatchSnapshot()
  })

  it('degrades the job panel at 40 columns', () => {
    expect(renderJobs(40, { selectedIndex: 1 })).toMatchSnapshot()
  })

  it('renders an armed cancellation and bounded completion notices', () => {
    expect(renderJobs(80, {
      confirmingCancelId: 'bash-1' as JobsSnapshot['jobs'][number]['id'],
      selectedIndex: 1,
      droppedNotices: 2,
      notices: [{
        id: 'bash-2' as JobsSnapshot['jobs'][number]['id'],
        label: 'pnpm build',
        status: 'failed',
      }],
      status: 'confirming',
    })).toMatchSnapshot()
  })

  it('states that the registry is unavailable rather than showing an empty list', () => {
    expect(renderJobs(80, {
      jobs: [],
      runningCount: 0,
      status: 'unavailable',
    })).toMatchSnapshot()
  })
})
