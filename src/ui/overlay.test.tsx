import { describe, expect, it } from 'vitest'

import type { ActivityCenterSnapshot } from '../model/activity-center-controller'
import type { CommandPaletteSnapshot } from '../model/command-palette-controller'
import type { ChangeIndexSnapshot } from '../model/change-index-controller'
import type { CompletionSnapshot } from '../model/completion-controller'
import type { JobsSnapshot } from '../model/jobs-controller'
import type { SessionCenterSnapshot } from '../model/session-center-controller'
import type { McpInventorySnapshot } from '../model/mcp-inventory-controller'
import type { SkillsSnapshot } from '../model/skills-controller'
import type { SubagentTreeSnapshot } from '../model/subagent-tree-controller'
import type { PermissionSnapshot } from '../model/permission-controller'
import type { PluginInventoryControllerSnapshot } from '../model/plugin-inventory-controller'
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
  workspaces: [],
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
      workspaces: [{ count: 1, label: 'workspace', root: '/workspace' }],
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

  const subagentRows: SubagentTreeSnapshot['rows'] = [{
    activity: 'running',
    depth: 1,
    hasChildren: true,
    id: 'child-a' as SubagentTreeSnapshot['rootSessionId'],
    kind: 'child',
    label: 'audit the change index',
    mode: 'continuable',
    parentId: 'root' as SubagentTreeSnapshot['rootSessionId'],
    unread: true,
  }, {
    activity: 'inactive',
    depth: 2,
    hasChildren: false,
    id: 'child-a1' as SubagentTreeSnapshot['rootSessionId'],
    kind: 'child',
    label: 'summarize findings',
    mode: 'one-shot',
    parentId: 'child-a' as SubagentTreeSnapshot['rootSessionId'],
    unread: false,
  }, {
    depth: 1,
    id: 'child-bad' as SubagentTreeSnapshot['rootSessionId'],
    kind: 'diagnostic',
    parentId: 'root' as SubagentTreeSnapshot['rootSessionId'],
    reason: 'corrupt',
    unread: false,
  }]

  function renderSubagents(
    columns: number,
    overrides: Partial<SubagentTreeSnapshot> = {},
    theme: 'default' | 'high-contrast' | 'no-color' = 'default',
  ): string {
    return renderOverlayPanel({
      active: 'subagents',
      theme,
      changes: emptyChanges,
      columns,
      completion: emptyCompletion,
      maxRows: 10,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
      subagents: {
        busy: false,
        followupText: '',
        revision: 3,
        rootSessionId: 'root' as SubagentTreeSnapshot['rootSessionId'],
        rows: subagentRows,
        status: 'ready',
        truncated: false,
        unreadCount: 1,
        ...overrides,
      },
    })
  }

  it('renders the subagent tree with depth, unread marks, and diagnostics at 80 columns', () => {
    expect(renderSubagents(80, { selectedIndex: 0 })).toMatchSnapshot()
  })

  it('degrades the subagent tree at 40 columns', () => {
    expect(renderSubagents(40, { selectedIndex: 0 })).toMatchSnapshot()
  })

  it('renders an armed subagent follow-up draft', () => {
    expect(renderSubagents(80, {
      followupText: 'check the truncation path too',
      selectedIndex: 0,
      status: 'followup-input',
    })).toMatchSnapshot()
  })

  it('states that the subagent runtime is unavailable rather than showing an empty tree', () => {
    expect(renderSubagents(80, { rows: [], status: 'unavailable', unreadCount: 0 }))
      .toMatchSnapshot()
  })

  function renderActivity(
    columns: number,
    overrides: Partial<ActivityCenterSnapshot> = {},
  ): string {
    return renderOverlayPanel({
      active: 'activity',
      activity: {
        counts: { jobsRunning: 2, subagentsUnread: 3, todosOpen: 4 },
        droppedNotifications: 0,
        notifications: [],
        revision: 7,
        rows: [{
          count: 1,
          detail: 'exit code: 3',
          key: 'jobs:bash-2',
          label: 'bash-2 failed: pnpm build',
          source: 'jobs',
          target: 'jobs',
        }, {
          count: 4,
          key: 'subagents:unread',
          label: '3 subagent updates (×4)',
          source: 'subagents',
          target: 'subagents',
        }, {
          count: 1,
          key: 'plan:pending',
          label: 'A plan is awaiting review',
          source: 'plan',
          target: 'projections',
        }],
        selectedIndex: 0,
        totalActivity: 8,
        ...overrides,
      },
      changes: emptyChanges,
      columns,
      completion: emptyCompletion,
      maxRows: 10,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
    })
  }

  function renderSkills(columns: number, overrides: Partial<SkillsSnapshot> = {}): string {
    return renderOverlayPanel({
      active: 'skills',
      changes: emptyChanges,
      columns,
      completion: emptyCompletion,
      maxRows: 12,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
      skills: {
        complete: true,
        hooks: 'unsupported-no-public-inventory',
        query: 'rev',
        revision: 2,
        rows: [{
          description: 'Review the diff for correctness',
          modelInvocable: true,
          name: 'review-code',
          provider: 'filesystem',
          source: 'project-dsh',
          userInvocable: true,
        }, {
          description: 'Internal routing helper',
          modelInvocable: true,
          name: 'route-review',
          provider: 'runtime',
          source: 'runtime',
          userInvocable: false,
        }],
        selectedIndex: 0,
        status: 'ready',
        totalMatches: 2,
        truncated: false,
        ...overrides,
      },
    })
  }

  function renderMcp(columns: number, overrides: Partial<McpInventorySnapshot> = {}): string {
    return renderOverlayPanel({
      active: 'mcp',
      changes: emptyChanges,
      columns,
      completion: emptyCompletion,
      maxRows: 12,
      mcp: {
        droppedServers: 0,
        health: 'unsupported-no-public-registry',
        nonMcpToolCount: 7,
        revision: 3,
        selectedIndex: 0,
        servers: [{
          droppedTools: 0,
          name: 'github',
          toolCount: 2,
          tools: [
            { description: 'Open an issue', qualifiedName: 'mcp__github__create_issue', rawName: 'create_issue' },
            { description: 'List repositories', qualifiedName: 'mcp__github__list_repos', rawName: 'list_repos' },
          ],
        }, {
          droppedTools: 3,
          name: 'figma',
          toolCount: 4,
          tools: [
            { description: 'Read a file', qualifiedName: 'mcp__figma__get_file', rawName: 'get_file' },
          ],
        }],
        status: 'ready',
        ...overrides,
      },
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
    })
  }

  function renderPlugins(
    columns: number,
    overrides: Partial<PluginInventoryControllerSnapshot> = {},
  ): string {
    return renderOverlayPanel({
      active: 'plugins',
      changes: emptyChanges,
      columns,
      completion: emptyCompletion,
      maxRows: 12,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      plugins: {
        diagnostics: [{
          entryId: 'e2',
          moduleName: '@scope/broken',
          summary: 'Enabled entry whose root fiber failed to load',
        }],
        droppedEntries: 0,
        failedCount: 1,
        mutation: 'read-only-no-public-transaction',
        revision: 4,
        rows: [{
          enabled: true, entryId: 'e1', fiberPhase: 'active', moduleName: '@scope/ok',
        }, {
          enabled: true, entryId: 'e2', fiberPhase: 'failed', moduleName: '@scope/broken',
        }, {
          enabled: false, entryId: 'e3', fiberPhase: 'none', moduleName: '@scope/off',
        }],
        selectedIndex: 1,
        status: 'ready',
        ...overrides,
      },
      recovery: emptyRecovery,
      sessions: emptySessions,
    })
  }

  it('renders plugin entries with phase, enablement, and the read-only boundary', () => {
    expect(renderPlugins(80)).toMatchSnapshot()
  })

  it('degrades the plugin inventory at 40 columns', () => {
    expect(renderPlugins(40)).toMatchSnapshot()
  })

  // rc.6 exposes the Loader projection only as a Typert remote gateway.
  it('states that no plugin inventory is mounted rather than showing nothing', () => {
    expect(renderPlugins(80, {
      diagnostics: [],
      failedCount: 0,
      rows: [],
      status: 'unavailable',
    })).toMatchSnapshot()
  })

  it('renders MCP servers grouped by name with the health boundary', () => {
    expect(renderMcp(80)).toMatchSnapshot()
  })

  it('degrades the MCP inventory at 40 columns', () => {
    expect(renderMcp(40)).toMatchSnapshot()
  })

  it('states that no MCP servers are registered rather than implying a failure', () => {
    expect(renderMcp(80, { nonMcpToolCount: 12, servers: [], status: 'ready' }))
      .toMatchSnapshot()
  })

  it('renders the skill catalog with invocation controls and the hook boundary', () => {
    expect(renderSkills(80)).toMatchSnapshot()
  })

  it('degrades the skill catalog at 40 columns', () => {
    expect(renderSkills(40)).toMatchSnapshot()
  })

  it('marks partial skill discovery instead of presenting it as the whole catalog', () => {
    expect(renderSkills(80, { complete: false })).toMatchSnapshot()
  })

  it('renders a loaded skill body without implying it was invoked', () => {
    expect(renderSkills(80, {
      detail: {
        content: 'Read the diff first.\nThen check the tests.',
        name: 'review-code',
        path: '/skills/review-code/SKILL.md',
        truncated: false,
      },
    })).toMatchSnapshot()
  })

  it('renders coalesced activity from all three sources at 80 columns', () => {
    expect(renderActivity(80)).toMatchSnapshot()
  })

  // Every semantic state must survive a terminal that renders no color, so the
  // distinction has to be carried by text, not only by tone.
  it.each(['default', 'high-contrast', 'no-color'] as const)(
    'renders every semantic job state under the %s theme',
    (theme) => {
      expect(renderOverlayPanel({
        active: 'jobs',
        changes: emptyChanges,
        columns: 80,
        completion: emptyCompletion,
        jobs: {
          confirmingCancelId: 'bash-1' as JobsSnapshot['jobs'][number]['id'],
          droppedNotices: 1,
          error: 'registry degraded',
          jobs: jobRows,
          notices: [{
            id: 'bash-2' as JobsSnapshot['jobs'][number]['id'],
            label: 'pnpm build',
            status: 'failed',
          }],
          outputCapability: 'unsupported-consuming-read',
          revision: 4,
          runningCount: 2,
          selectedIndex: 1,
          status: 'confirming',
          truncated: true,
        },
        maxRows: 12,
        palette: {
          catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
        },
        permissions: emptyPermissions,
        recovery: emptyRecovery,
        sessions: emptySessions,
        theme,
      })).toMatchSnapshot()
    },
  )

  it.each(['default', 'no-color'] as const)(
    'renders every semantic subagent state under the %s theme',
    (theme) => {
      expect(renderSubagents(80, { selectedIndex: 0 }, theme)).toMatchSnapshot()
    },
  )

  // The accessibility claim: dropping color must lose no information, so the
  // rendered text has to be identical with and without it.
  it('carries no information in color alone', () => {
    expect(renderSubagents(80, { selectedIndex: 0 }, 'no-color'))
      .toBe(renderSubagents(80, { selectedIndex: 0 }, 'default'))
    expect(renderSubagents(80, { selectedIndex: 0 }, 'high-contrast'))
      .toBe(renderSubagents(80, { selectedIndex: 0 }, 'default'))
  })

  it('degrades the activity center at 40 columns', () => {
    expect(renderActivity(40)).toMatchSnapshot()
  })

  it('renders an empty activity center without implying a failure', () => {
    expect(renderActivity(80, {
      counts: { jobsRunning: 0, subagentsUnread: 0, todosOpen: 0 },
      rows: [],
      totalActivity: 0,
    })).toMatchSnapshot()
  })

  it('states that the registry is unavailable rather than showing an empty list', () => {
    expect(renderJobs(80, {
      jobs: [],
      runningCount: 0,
      status: 'unavailable',
    })).toMatchSnapshot()
  })

  // A screen reader announces every border glyph as content, so the frame
  // becomes noise wrapped around the text the user asked for.
  it('drops box drawing in screen-reader mode without losing any text', () => {
    const bordered = renderMcp(80)
    const plain = renderOverlayPanel({
      active: 'mcp',
      changes: emptyChanges,
      columns: 80,
      completion: emptyCompletion,
      maxRows: 12,
      mcp: {
        droppedServers: 0,
        health: 'unsupported-no-public-registry',
        nonMcpToolCount: 7,
        revision: 3,
        selectedIndex: 0,
        servers: [{
          droppedTools: 0,
          name: 'github',
          toolCount: 1,
          tools: [{
            description: 'Open an issue',
            qualifiedName: 'mcp__github__create_issue',
            rawName: 'create_issue',
          }],
        }],
        status: 'ready',
      },
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      screenReader: true,
      sessions: emptySessions,
    })

    expect(bordered).toMatch(/[\u2500-\u257F]/)
    expect(plain).not.toMatch(/[\u2500-\u257F]/)
    expect(plain).toContain('github')
    expect(plain).toContain('Connection health: no public registry')
    expect(plain).toMatchSnapshot()
  })

  it('renders a change path as an OSC 8 link on a capable terminal', () => {
    const change = {
      callId: 'call-a',
      eventSeq: 2,
      expanded: false,
      id: 'call-a:0',
      newText: 'new',
      oldText: 'old',
      path: '/repo/src/a.ts',
      phase: 'applied' as const,
      rowId: 'tool:call-a',
      title: 'Edit a.ts',
      truncated: false,
    }
    const changes = {
      droppedChanges: 0,
      groups: [{ changes: [change], path: '/repo/src/a.ts' }],
      invalidDiffs: 0,
      revision: 1,
      selectedIndex: 0,
      totalChanges: 1,
      truncated: false,
    }
    const base = {
      active: 'changes' as const,
      changes,
      columns: 80,
      completion: emptyCompletion,
      maxRows: 10,
      palette: {
        catalogTruncated: false, items: [], query: '', revision: 0, totalMatches: 0,
      },
      permissions: emptyPermissions,
      recovery: emptyRecovery,
      sessions: emptySessions,
    }

    const linked = renderOverlayPanel({
      ...base,
      terminalCapabilities: { hyperlinks: true, inlineImages: false },
    })
    const plain = renderOverlayPanel({
      ...base,
      terminalCapabilities: { hyperlinks: false, inlineImages: false },
    })

    expect(linked).toContain('\u001B]8;;file://')
    // The fallback keeps the path visible on a terminal that cannot link.
    expect(plain).not.toContain('\u001B]8;;')
    expect(plain).toContain('/repo/src/a.ts')
  })
})

