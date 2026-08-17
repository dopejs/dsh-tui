import { Box, Text, renderToString } from 'ink'

import type { ActivityCenterSnapshot } from '../model/activity-center-controller'
import type { AttachmentsSnapshot } from '../model/attachments-controller'
import type { ChangeIndexSnapshot, IndexedChange } from '../model/change-index-controller'
import type { CommandPaletteSnapshot } from '../model/command-palette-controller'
import type { CompletionSnapshot } from '../model/completion-controller'
import type { JobsSnapshot } from '../model/jobs-controller'
import type { McpInventorySnapshot } from '../model/mcp-inventory-controller'
import type { OverlayKind } from '../model/overlay-controller'
import type { PermissionSnapshot } from '../model/permission-controller'
import type { PluginInventoryControllerSnapshot } from '../model/plugin-inventory-controller'
import type { ProjectionHubSnapshot } from '../model/projection-hub-controller'
import type { RecoverySnapshot } from '../model/recovery-controller'
import type { SessionCenterSnapshot } from '../model/session-center-controller'
import type { SkillsSnapshot } from '../model/skills-controller'
import type { SubagentTreeSnapshot } from '../model/subagent-tree-controller'
import type { TuiTheme } from '../model/preferences-controller'
import { fileHyperlink, type TerminalCapabilities } from './terminal-links'
import { toneStyle, type SemanticTone } from './theme'

interface OverlayWindow<T> {
  readonly end: number
  readonly rows: readonly T[]
  readonly start: number
}

function selectedWindow<T>(
  rows: readonly T[],
  selectedIndex: number | undefined,
  maximum: number,
): OverlayWindow<T> {
  const limit = Math.max(1, maximum)
  if (rows.length <= limit) return { end: rows.length, rows, start: 0 }
  const selected = Math.max(0, Math.min(rows.length - 1, selectedIndex ?? 0))
  const start = Math.max(0, Math.min(rows.length - limit, selected - Math.floor(limit / 2)))
  return { end: start + limit, rows: rows.slice(start, start + limit), start }
}

interface OverlayPanelProps {
  readonly active: OverlayKind
  readonly activity: ActivityCenterSnapshot
  readonly attachments: AttachmentsSnapshot
  readonly changes: ChangeIndexSnapshot
  readonly columns: number
  readonly completion: CompletionSnapshot
  readonly jobs: JobsSnapshot
  readonly maxRows: number
  readonly mcp: McpInventorySnapshot
  readonly palette: CommandPaletteSnapshot
  readonly permissions: PermissionSnapshot
  readonly plugins: PluginInventoryControllerSnapshot
  readonly projections: ProjectionHubSnapshot
  readonly recovery: RecoverySnapshot
  /** Drop box drawing; a screen reader reads border glyphs as content. */
  readonly screenReader?: boolean
  readonly sessions: SessionCenterSnapshot
  readonly skills: SkillsSnapshot
  readonly subagents: SubagentTreeSnapshot
  /** Negotiated once at startup; absent means assume no hyperlinks. */
  readonly terminalCapabilities?: TerminalCapabilities
  readonly theme: TuiTheme
}

export function OverlayPanel({
  active,
  activity,
  attachments,
  changes,
  columns,
  completion,
  jobs,
  maxRows,
  mcp,
  palette,
  permissions,
  plugins,
  projections,
  recovery,
  screenReader = false,
  sessions,
  skills,
  subagents,
  terminalCapabilities,
  theme,
}: OverlayPanelProps) {
  const tone = (name: Parameters<typeof toneStyle>[1]) => toneStyle(theme, name)
  // A screen reader announces every border character, so the frame becomes
  // noise wrapped around the text the user actually asked for.
  const frame = screenReader ? {} : { borderStyle: 'round' as const }
  if (active === 'attachments') {
    const limits = attachments.limits
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Attachments · {attachments.status} · {String(attachments.rows.length)} staged
          {limits === undefined
            ? ''
            : ` · max ${String(Math.floor(limits.maxImageBytes / 1_048_576))} MiB each`}
        </Text>
        <Text wrap="truncate-end">&gt; {attachments.draftPath}█</Text>
        {attachments.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{attachments.error}</Text>
        )}
        {attachments.rows.map(row => (
          <Text key={row.attachmentId} wrap="truncate-end">
            {'  '}[image {row.name ?? row.attachmentId} · {row.mediaType}
            {' · '}{String(row.width)}×{String(row.height)}
            {' · '}{String(Math.ceil(row.bytes / 1024))} KiB]
          </Text>
        ))}
        {/* The textual row above is shown either way, so an attachment is
            never invisible on a terminal that cannot draw it. */}
        <Text {...tone('muted')} wrap="truncate-end">
          {attachments.inlineImages
            ? 'This terminal can draw images inline.'
            : 'This terminal cannot draw images; the description above is the fallback.'}
        </Text>
        <Text dimColor wrap="truncate-end">
          {attachments.status === 'unavailable'
            ? 'No attachment store on this Harness baseline · Esc close'
            : 'type a path · Enter attach · ^D drop last · ^X clear · Esc close'}
        </Text>
      </Box>
    )
  }

  if (active === 'plugins') {
    const window = selectedWindow(plugins.rows, plugins.selectedIndex, maxRows - 6)
    const selected = plugins.rows[plugins.selectedIndex ?? -1]
    const diagnostic = selected === undefined
      ? undefined
      : plugins.diagnostics.find(entry => entry.entryId === selected.entryId)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Plugins · {plugins.status} · {String(plugins.rows.length)} entries
          {plugins.failedCount > 0 ? ` · ${String(plugins.failedCount)} failed` : ''}
          {plugins.droppedEntries > 0 ? ` · ${String(plugins.droppedEntries)} not shown` : ''}
        </Text>
        {plugins.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{plugins.error}</Text>
        )}
        {window.rows.map((row, index) => {
          const absolute = window.start + index
          const isSelected = absolute === plugins.selectedIndex
          const phaseTone: SemanticTone | undefined = row.fiberPhase === 'failed'
            ? 'danger'
            : row.fiberPhase === 'active' ? 'positive' : undefined
          return (
            <Text
              {...tone(phaseTone)}
              dimColor={!row.enabled}
              inverse={isSelected}
              key={row.entryId}
              wrap="truncate-end"
            >
              {isSelected ? '›' : ' '} {row.enabled ? 'enabled ' : 'disabled'} · {row.fiberPhase}
              {' · '}{row.moduleName}
            </Text>
          )
        })}
        {diagnostic === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">  {diagnostic.summary}</Text>
        )}
        {/* No public Loader or settings transaction owns enablement here, so a
            toggle would let the running fiber and the stored profile disagree. */}
        <Text {...tone('muted')} wrap="truncate-end">
          Read-only: no public transaction owns plugin enablement
        </Text>
        <Text dimColor wrap="truncate-end">
          {plugins.rows.length === 0
            ? 'No plugin inventory on this Harness baseline · R refresh · Esc close'
            : `${String((plugins.selectedIndex ?? 0) + 1)}/${String(plugins.rows.length)} · ↑/↓ select · R refresh · Esc close`}
        </Text>
      </Box>
    )
  }

  if (active === 'mcp') {
    const selected = mcp.servers[mcp.selectedIndex ?? -1]
    const window = selectedWindow(mcp.servers, mcp.selectedIndex, maxRows - 6)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          MCP · {mcp.status} · {String(mcp.servers.length)} servers
          {mcp.droppedServers > 0 ? ` · ${String(mcp.droppedServers)} not shown` : ''}
        </Text>
        {mcp.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{mcp.error}</Text>
        )}
        {window.rows.map((server, index) => {
          const absolute = window.start + index
          const isSelected = absolute === mcp.selectedIndex
          return (
            <Text inverse={isSelected} key={server.name} wrap="truncate-end">
              {isSelected ? '›' : ' '} {server.name} · {String(server.toolCount)} tools
              {server.droppedTools > 0 ? ` · ${String(server.droppedTools)} not shown` : ''}
            </Text>
          )
        })}
        {selected === undefined ? null : (
          <Box flexDirection="column">
            {selected.tools.slice(0, 4).map(row => (
              <Text dimColor key={row.qualifiedName} wrap="truncate-end">
                {'  '}{row.rawName} · {row.description}
              </Text>
            ))}
          </Box>
        )}
        {/* The baseline publishes no MCP health registry; a tool list says
            nothing about the transport, so no state is inferred from it. */}
        <Text {...tone('muted')} wrap="truncate-end">
          Connection health: no public registry on this Harness baseline
          {' · '}{String(mcp.nonMcpToolCount)} non-MCP tools
        </Text>
        <Text dimColor wrap="truncate-end">
          {mcp.servers.length === 0
            ? 'No MCP servers registered · R refresh · Esc close'
            : `${String((mcp.selectedIndex ?? 0) + 1)}/${String(mcp.servers.length)} · ↑/↓ select · R refresh · Esc close`}
        </Text>
      </Box>
    )
  }

  if (active === 'skills') {
    const detail = skills.detail
    const window = selectedWindow(skills.rows, skills.selectedIndex, maxRows - (detail ? 9 : 6))
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Skills · {skills.status} · {String(skills.totalMatches)} matching
          {skills.complete ? '' : ' · partial discovery'}
          {skills.truncated ? ' · truncated' : ''}
        </Text>
        <Text wrap="truncate-end">&gt; {skills.query}█</Text>
        {skills.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{skills.error}</Text>
        )}
        {window.rows.map((row, index) => {
          const absolute = window.start + index
          const selected = absolute === skills.selectedIndex
          return (
            <Text
              {...(row.userInvocable ? {} : tone('muted'))}
              inverse={selected}
              key={row.name}
              wrap="truncate-end"
            >
              {selected ? '›' : ' '} /{row.name} · {row.description}
              {row.userInvocable ? '' : ' · model only'} · {row.source}
            </Text>
          )
        })}
        {detail === undefined ? null : (
          <Box flexDirection="column">
            <Text {...tone('accent')} wrap="truncate-end">
              {detail.name}{detail.path === undefined ? '' : ` · ${detail.path}`}
              {detail.truncated ? ' · truncated' : ''}
            </Text>
            {detail.content.split('\n').slice(0, 3).map((line, index) => (
              <Text dimColor key={`detail:${String(index)}`} wrap="truncate-end">  {line}</Text>
            ))}
          </Box>
        )}
        {/* rc.6 publishes no hook inventory; saying so beats guessing at one. */}
        <Text {...tone('muted')} wrap="truncate-end">
          Hooks: no public inventory on this Harness baseline
        </Text>
        <Text dimColor wrap="truncate-end">
          {skills.rows.length === 0
            ? 'type to filter · R refresh · Esc close'
            : `${String((skills.selectedIndex ?? 0) + 1)}/${String(skills.rows.length)} · ↑/↓ select · Enter insert · ^D details · R refresh · Esc close`}
        </Text>
      </Box>
    )
  }

  if (active === 'activity') {
    const window = selectedWindow(activity.rows, activity.selectedIndex, maxRows - 4)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Activity · {String(activity.counts.jobsRunning)} jobs running
          {' · '}{String(activity.counts.subagentsUnread)} subagent updates
          {' · '}{String(activity.counts.todosOpen)} todos open
        </Text>
        {window.rows.map((row, index) => {
          const absolute = window.start + index
          const selected = absolute === activity.selectedIndex
          return (
            <Box flexDirection="column" key={row.key}>
              <Text inverse={selected} wrap="truncate-end">
                {selected ? '›' : ' '} [{row.source}] {row.label}
              </Text>
              {selected && row.detail !== undefined ? (
                <Text dimColor wrap="truncate-end">  {row.detail}</Text>
              ) : null}
            </Box>
          )
        })}
        <Text dimColor wrap="truncate-end">
          {activity.rows.length === 0
            ? 'Nothing pending · Esc close'
            : `${String((activity.selectedIndex ?? 0) + 1)}/${String(activity.rows.length)} · ↑/↓ select · Enter open · D dismiss · C clear all · Esc close`}
          {activity.droppedNotifications > 0
            ? ` · ${String(activity.droppedNotifications)} dropped`
            : ''}
          {window.start > 0 ? ` · ${String(window.start)} above` : ''}
          {window.end < activity.rows.length
            ? ` · ${String(activity.rows.length - window.end)} below`
            : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'subagents') {
    const window = selectedWindow(subagents.rows, subagents.selectedIndex, maxRows - 5)
    const selected = subagents.rows[subagents.selectedIndex ?? -1]
    const canFollowup = selected?.kind === 'child'
      && selected.mode === 'continuable'
      && selected.depth === 1
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Subagents · {subagents.status}
          {subagents.unreadCount > 0 ? ` · ${String(subagents.unreadCount)} unread` : ''}
          {subagents.truncated ? ' · truncated' : ''}
        </Text>
        {subagents.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{subagents.error}</Text>
        )}
        {window.rows.map((row, index) => {
          const absolute = window.start + index
          const isSelected = absolute === subagents.selectedIndex
          const indent = '  '.repeat(Math.max(0, row.depth - 1))
          if (row.kind === 'diagnostic') {
            return (
              <Text {...tone('danger')} inverse={isSelected} key={String(row.id)} wrap="truncate-end">
                {isSelected ? '›' : ' '} {indent}{String(row.id)} · unreadable ({row.reason})
              </Text>
            )
          }
          return (
            <Text
              {...(row.activity === 'running' ? tone('positive') : {})}
              dimColor={row.activity === 'inactive'}
              inverse={isSelected}
              key={String(row.id)}
              wrap="truncate-end"
            >
              {isSelected ? '›' : ' '} {indent}{row.unread ? '•' : ' '}
              {row.label ?? String(row.id)} · {row.mode} · {row.activity}
              {row.hasChildren === true ? ' · has children' : ''}
            </Text>
          )
        })}
        {subagents.status === 'followup-input' ? (
          <Text {...tone('warning')} wrap="truncate-end">
            Follow up: {subagents.followupText}█ · Enter send · Esc cancel
          </Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {subagents.rows.length === 0
            ? 'R refresh · Esc close'
            : `${String((subagents.selectedIndex ?? 0) + 1)}/${String(subagents.rows.length)} · ↑/↓ select${canFollowup ? ' · F follow up' : ''} · I interrupt · A attach · M mark read · R refresh · Esc close`}
          {window.start > 0 ? ` · ${String(window.start)} above` : ''}
          {window.end < subagents.rows.length
            ? ` · ${String(subagents.rows.length - window.end)} below`
            : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'jobs') {
    const window = selectedWindow(jobs.jobs, jobs.selectedIndex, maxRows - 5)
    const confirming = jobs.jobs.find(job => job.id === jobs.confirmingCancelId)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Jobs · {jobs.status} · {String(jobs.runningCount)} running
          {jobs.truncated ? ' · truncated' : ''}
        </Text>
        {jobs.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{jobs.error}</Text>
        )}
        {jobs.notices.length === 0 && jobs.droppedNotices === 0 ? null : (
          <Text {...tone('accent')} wrap="truncate-end">
            {jobs.notices.map(notice => `${String(notice.id)} ${notice.status}`).join(' · ')}
            {jobs.droppedNotices > 0 ? ` · +${String(jobs.droppedNotices)} more` : ''}
            {' · A acknowledge'}
          </Text>
        )}
        {window.rows.map((job, index) => {
          const absolute = window.start + index
          const selected = absolute === jobs.selectedIndex
          const color = job.status === 'failed'
            ? 'red'
            : job.status === 'completed'
              ? 'green'
              : job.status === 'killed' ? 'yellow' : undefined
          return (
            <Box flexDirection="column" key={String(job.id)}>
              <Text
                {...(color === undefined ? {} : { color })}
                inverse={selected}
                wrap="truncate-end"
              >
                {selected ? '›' : ' '} {String(job.id)} · {job.status}
                {job.owned ? '' : ' · unowned'} · {job.label}
              </Text>
              {selected && job.detail !== undefined ? (
                <Text dimColor wrap="truncate-end">  {job.detail}</Text>
              ) : null}
            </Box>
          )
        })}
        {confirming === undefined ? null : (
          <Text {...tone('warning')} wrap="truncate-end">
            Cancel {String(confirming.id)}? Enter confirm · Esc dismiss
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {/* The registry's only output seam consumes the owning agent's notice. */}
          Output stays with the agent · {jobs.jobs.length === 0
            ? 'R refresh · Esc close'
            : `${String((jobs.selectedIndex ?? 0) + 1)}/${String(jobs.jobs.length)} · ↑/↓ select · K cancel · R refresh · Esc close`}
          {window.start > 0 ? ` · ${String(window.start)} above` : ''}
          {window.end < jobs.jobs.length ? ` · ${String(jobs.jobs.length - window.end)} below` : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'projections') {
    const window = selectedWindow(projections.rows, projections.selectedIndex, maxRows - 4)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Projections · {projections.status}
          {projections.asOfSeq === undefined ? '' : ` · seq ${String(projections.asOfSeq)}`}
        </Text>
        {projections.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{projections.error}</Text>
        )}
        {window.rows.map((row, index) => {
          const absolute = window.start + index
          const selected = absolute === projections.selectedIndex
          const color = row.tone === 'negative'
            ? 'red'
            : row.tone === 'positive'
              ? 'green'
              : row.tone === 'warning' ? 'yellow' : undefined
          return (
            <Box flexDirection="column" key={row.id}>
              <Text
                {...(color === undefined ? {} : { color })}
                dimColor={row.tone === 'dim'}
                inverse={selected}
                wrap="truncate-end"
              >
                {selected ? '›' : ' '} {row.label}
              </Text>
              {selected && row.detail !== undefined ? (
                <Text dimColor wrap="truncate-end">  {row.detail}</Text>
              ) : null}
            </Box>
          )
        })}
        <Text dimColor wrap="truncate-end">
          {projections.rows.length === 0
            ? 'R refresh · Esc close'
            : `${String((projections.selectedIndex ?? 0) + 1)}/${String(projections.rows.length)} · ↑/↓ inspect · R refresh · Esc close`}
          {window.start > 0 ? ` · ${String(window.start)} above` : ''}
          {window.end < projections.rows.length
            ? ` · ${String(projections.rows.length - window.end)} below`
            : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'recovery') {
    const window = selectedWindow(
      recovery.capabilities,
      recovery.selectedIndex,
      Math.max(1, maxRows - 7),
    )
    const selected = recovery.capabilities[recovery.selectedIndex]
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Recovery · {recovery.sessionId} · {recovery.status}
        </Text>
        {window.rows.map((capability, index) => {
          const absolute = window.start + index
          const isSelected = absolute === recovery.selectedIndex
          return (
            <Text inverse={isSelected} key={capability.id} wrap="truncate-end">
              {isSelected ? '›' : ' '} {capability.available ? '●' : '○'} {capability.title}
              {' · '}{capability.available ? 'available' : 'unavailable'}
            </Text>
          )
        })}
        {selected === undefined ? null : (
          <Text dimColor wrap="truncate-end">{selected.detail}</Text>
        )}
        {recovery.status === 'export-input' ? (
          <>
            <Text wrap="truncate-end">Destination (existing files are never overwritten)</Text>
            <Text wrap="truncate-end">
              &gt; {recovery.destination}<Text inverse>█</Text>
              {recovery.destination === ''
                ? <Text dimColor> {recovery.suggestedExportDestination}</Text>
                : null}
            </Text>
          </>
        ) : null}
        {recovery.status === 'confirming-fork' ? (
          <Text {...tone('warning')} wrap="truncate-end">
            Fork conversation only; current workspace files are not rewound. Enter confirms.
          </Text>
        ) : null}
        {recovery.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{recovery.error}</Text>
        )}
        {recovery.result === undefined ? null : (
          <Text {...tone('positive')} wrap="truncate-end">{recovery.result}</Text>
        )}
        <Text dimColor wrap="truncate-end">
          {recovery.status === 'export-input'
            ? 'Enter export · Esc cancel'
            : recovery.status === 'confirming-fork'
              ? 'Enter fork · Esc cancel'
              : recovery.status === 'running'
                ? `Running ${recovery.activeOperation ?? 'recovery'}… · Esc cancel`
                : '↑/↓ select · Enter activate · Esc close'}
        </Text>
      </Box>
    )
  }

  if (active === 'changes') {
    const flattened = changes.groups.flatMap(group => group.changes.map((change, index) => ({
      change,
      groupCount: group.changes.length,
      groupIndex: index,
    })))
    const selected = changes.selectedIndex === undefined
      ? undefined
      : flattened[changes.selectedIndex]?.change
    const listRows = selected?.expanded === true
      ? Math.max(1, Math.floor((maxRows - 5) / 2))
      : Math.max(1, maxRows - 4)
    const window = selectedWindow(flattened, changes.selectedIndex, listRows)
    const detailMaximum = Math.max(1, maxRows - window.rows.length - 4)
    const detail = selected?.expanded === true ? diffLines(selected, detailMaximum) : undefined
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Changes · {String(changes.groups.length)} files · {String(changes.totalChanges)} edits
        </Text>
        {window.rows.length === 0 ? (
          <Text dimColor>No durable diff presentations in this session</Text>
        ) : window.rows.map((item, index) => {
          const absolute = window.start + index
          const isSelected = absolute === changes.selectedIndex
          return (
            <Text inverse={isSelected} key={item.change.id} wrap="truncate-end">
              {isSelected ? '›' : ' '} {item.change.expanded ? '▾' : '▸'}{' '}
              {/* Falls back to the plain path when the terminal cannot link. */}
              {fileHyperlink(item.change.path, {
                ...(terminalCapabilities === undefined ? {} : { capabilities: terminalCapabilities }),
              })}
              {item.groupCount > 1 ? ` [${String(item.groupIndex + 1)}/${String(item.groupCount)}]` : ''}
              {' · '}{item.change.phase}{' · '}{item.change.title}
            </Text>
          )
        })}
        {detail === undefined ? null : detail.lines.map((line, index) => (
          <Text
            {...tone(diffLineTone(line))}
            key={`${selected?.id ?? 'detail'}:${String(index)}`}
            wrap="truncate-end"
          >
            {line}
          </Text>
        ))}
        <Text dimColor wrap="truncate-end">
          {changes.totalChanges === 0
            ? 'Esc close'
            : '↑/↓ select · Enter fold/expand · J jump to transcript · Esc close'}
          {changes.truncated ? ` · truncated (${String(changes.droppedChanges)} dropped)` : ''}
          {changes.invalidDiffs > 0 ? ` · ${String(changes.invalidDiffs)} invalid ignored` : ''}
          {detail?.truncated === true ? ' · diff folded to fit' : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'command-palette') {
    const window = selectedWindow(palette.items, palette.selectedIndex, maxRows - 5)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">Command palette</Text>
        <Text wrap="truncate-end">
          &gt; {palette.query}<Text inverse>█</Text>
        </Text>
        {palette.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{palette.error}</Text>
        )}
        {window.rows.length === 0 && palette.error === undefined ? (
          <Text dimColor wrap="truncate-end">No matching commands or actions</Text>
        ) : window.rows.map((item, index) => {
          const absolute = window.start + index
          const selected = absolute === palette.selectedIndex
          return (
            <Text inverse={selected} key={item.id} wrap="truncate-end">
              {selected ? '›' : ' '} {item.label}
              {item.kind === 'command' && item.inputHint !== undefined ? ` ${item.inputHint}` : ''}
              {' · '}{item.description}
            </Text>
          )
        })}
        <Text dimColor wrap="truncate-end">
          {palette.items.length === 0
            ? 'Esc close'
            : `${String((palette.selectedIndex ?? 0) + 1)}/${String(palette.totalMatches)} · Enter select · Esc close`}
          {palette.catalogTruncated ? ' · catalog truncated' : ''}
          {window.start > 0 ? ` · ${String(window.start)} above` : ''}
          {window.end < palette.items.length
            ? ` · ${String(palette.items.length - window.end)} below`
            : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'session-center') {
    const window = selectedWindow(sessions.items, sessions.selectedIndex, maxRows - 6)
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">
          Session center · {sessions.status}
          {sessions.workspaceRoot === undefined
            ? ''
            : ` · workspace ${sessions.workspaceRoot}`}
        </Text>
        {sessions.workspaces.length === 0 ? null : (
          <Text {...tone('muted')} wrap="truncate-end">
            {/* Resuming stays in this process's root; W cycles what is listed. */}
            W cycles workspace:{' '}
            {sessions.workspaces
              .map(group => `${group.label} (${String(group.count)})`)
              .join(' · ')}
          </Text>
        )}
        <Text wrap="truncate-end">
          &gt; {sessions.query}<Text inverse>█</Text>
        </Text>
        {sessions.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{sessions.error}</Text>
        )}
        {window.rows.length === 0 && sessions.status !== 'loading' ? (
          <Text dimColor>No matching persisted sessions</Text>
        ) : window.rows.map((item, index) => {
          const absolute = window.start + index
          const selected = absolute === sessions.selectedIndex
          return (
            <Text inverse={selected} key={item.id} wrap="truncate-end">
              {selected ? '›' : ' '} {item.isCurrent ? '●' : '○'} {item.id}
              {' · '}{new Date(item.createdAt).toISOString()}
              {item.cwd === undefined ? '' : ` · ${item.cwd}`}
            </Text>
          )
        })}
        {sessions.preview === undefined ? null : (
          <Text dimColor wrap="truncate-end">
            Preview {sessions.preview.id} · {String(sessions.preview.eventCount)} events
            {sessions.preview.lastEventType === undefined
              ? ''
              : ` · last ${sessions.preview.lastEventType}`}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {sessions.items.length === 0
            ? 'R refresh · Esc close'
            : `${String((sessions.selectedIndex ?? 0) + 1)}/${String(sessions.totalMatches)} · Enter resume · Space preview · R refresh`}
          {sessions.catalogTruncated ? ' · catalog truncated' : ''}
        </Text>
      </Box>
    )
  }

  if (active === 'permissions') {
    const window = selectedWindow(permissions.items, permissions.selectedIndex, maxRows - 6)
    const confirmation = permissions.items.find(
      item => item.value === permissions.confirmationTarget,
    )
    return (
      <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">Permissions · {permissions.status}</Text>
        {permissions.status === 'confirming' ? (
          <>
            <Text {...tone('danger')} wrap="truncate-end">
              Danger: sandbox {confirmation?.sandbox ?? 'unrestricted'} · approval{' '}
              {confirmation?.approval ?? 'unknown'}.
            </Text>
            <Text wrap="truncate-end">Type {permissions.confirmationPhrase}</Text>
            <Text wrap="truncate-end">&gt; {permissions.confirmationText}<Text inverse>█</Text></Text>
          </>
        ) : window.rows.map((item, index) => {
          const absolute = window.start + index
          const selected = absolute === permissions.selectedIndex
          return (
            <Box flexDirection="column" key={item.value}>
              <Text inverse={selected} wrap="truncate-end">
                {selected ? '›' : ' '} {item.selected ? '●' : '○'} {item.name}
                {' · sandbox '}{item.sandbox}{' · approval '}{item.approval}
              </Text>
              {selected && item.description !== undefined
                ? <Text dimColor wrap="truncate-end">  {item.description}</Text>
                : null}
            </Box>
          )
        })}
        {permissions.status === 'unavailable' ? (
          <Text dimColor>Permission preset service unavailable</Text>
        ) : null}
        {permissions.error === undefined ? null : (
          <Text {...tone('danger')} wrap="truncate-end">{permissions.error}</Text>
        )}
        <Text dimColor wrap="truncate-end">
          {permissions.status === 'confirming'
            ? 'Enter confirm · Esc cancel'
            : permissions.items.length === 0
              ? 'Esc close'
              : 'Enter select · Esc close'}
          {permissions.truncated ? ' · presets truncated' : ''}
        </Text>
      </Box>
    )
  }

  const window = selectedWindow(completion.items, completion.selectedIndex, maxRows - 4)
  const kind = completion.kind === 'path' ? 'Path' : 'Command'
  return (
    <Box {...frame} flexDirection="column" width={Math.max(4, columns)}>
      <Text bold wrap="truncate-end">{kind} completion · {completion.query}</Text>
      {completion.status === 'loading' ? <Text dimColor>Loading…</Text> : null}
      {completion.error === undefined ? null : (
        <Text {...tone('danger')} wrap="truncate-end">{completion.error}</Text>
      )}
      {completion.status === 'ready' && window.rows.length === 0 ? (
        <Text dimColor>No matching completion</Text>
      ) : window.rows.map((item, index) => {
        const absolute = window.start + index
        const selected = absolute === completion.selectedIndex
        return (
          <Text inverse={selected} key={item.id} wrap="truncate-end">
            {selected ? '›' : ' '} {item.label}
            {item.description === undefined ? '' : ` · ${item.description}`}
          </Text>
        )
      })}
      <Text dimColor wrap="truncate-end">
        {completion.items.length === 0
          ? 'Esc close'
          : `${String((completion.selectedIndex ?? 0) + 1)}/${String(completion.items.length)} · Enter apply · Esc close`}
        {completion.truncated ? ' · results truncated' : ''}
      </Text>
    </Box>
  )
}

function diffLines(change: IndexedChange, maximum: number): {
  readonly lines: readonly string[]
  readonly truncated: boolean
} {
  const lines = [
    `--- ${change.oldText === null ? '/dev/null' : change.path}`,
    `+++ ${change.path}`,
    ...(textLines(change.oldText).map(line => `- ${line}`)),
    ...(textLines(change.newText).map(line => `+ ${line}`)),
  ]
  const truncated = lines.length > maximum
  return {
    lines: Object.freeze(truncated
      ? [...lines.slice(0, Math.max(0, maximum - 1)), '… diff continues']
      : lines),
    truncated,
  }
}

function diffLineTone(line: string): SemanticTone | undefined {
  if (line.startsWith('+++') || line.startsWith('+ ')) return 'positive'
  if (line.startsWith('---') || line.startsWith('- ')) return 'danger'
  return undefined
}

function textLines(value: string | null): readonly string[] {
  return value === null || value === '' ? [] : value.split('\n')
}

export function renderOverlayPanel(
  props: Omit<OverlayPanelProps, 'activity' | 'attachments' | 'jobs' | 'mcp' | 'plugins' | 'projections' | 'skills' | 'subagents' | 'theme'> & {
    readonly activity?: ActivityCenterSnapshot
    readonly attachments?: AttachmentsSnapshot
    readonly terminalCapabilities?: TerminalCapabilities
    readonly mcp?: McpInventorySnapshot
    readonly screenReader?: boolean
    readonly plugins?: PluginInventoryControllerSnapshot
    readonly skills?: SkillsSnapshot
    readonly theme?: TuiTheme
    readonly jobs?: JobsSnapshot
    readonly projections?: ProjectionHubSnapshot
    readonly subagents?: SubagentTreeSnapshot
  },
): string {
  const plugins: PluginInventoryControllerSnapshot = props.plugins ?? {
    diagnostics: [],
    droppedEntries: 0,
    failedCount: 0,
    mutation: 'read-only-no-public-transaction',
    revision: 0,
    rows: [],
    status: 'unavailable',
  }
  const mcp: McpInventorySnapshot = props.mcp ?? {
    droppedServers: 0,
    health: 'unsupported-no-public-registry',
    nonMcpToolCount: 0,
    revision: 0,
    servers: [],
    status: 'unavailable',
  }
  const skills: SkillsSnapshot = props.skills ?? {
    complete: true,
    hooks: 'unsupported-no-public-inventory',
    query: '',
    revision: 0,
    rows: [],
    status: 'unavailable',
    totalMatches: 0,
    truncated: false,
  }
  const attachments: AttachmentsSnapshot = props.attachments ?? {
    draftPath: '',
    inlineImages: false,
    revision: 0,
    rows: [],
    status: 'unavailable',
  }
  const activity: ActivityCenterSnapshot = props.activity ?? {
    counts: { jobsRunning: 0, subagentsUnread: 0, todosOpen: 0 },
    droppedNotifications: 0,
    notifications: [],
    revision: 0,
    rows: [],
    totalActivity: 0,
  }
  const subagents: SubagentTreeSnapshot = props.subagents ?? {
    busy: false,
    followupText: '',
    revision: 0,
    rootSessionId: 'root' as SubagentTreeSnapshot['rootSessionId'],
    rows: [],
    status: 'unavailable',
    truncated: false,
    unreadCount: 0,
  }
  const jobs: JobsSnapshot = props.jobs ?? {
    droppedNotices: 0,
    jobs: [],
    notices: [],
    outputCapability: 'unsupported-consuming-read',
    revision: 0,
    runningCount: 0,
    status: 'unavailable',
    truncated: false,
  }
  const projections: ProjectionHubSnapshot = props.projections ?? {
    capabilities: {
      goal: 'unavailable', plan: 'unavailable', todos: 'unavailable', usage: 'unavailable',
    },
    diagnostics: [],
    droppedDiagnostics: 0,
    droppedTodos: 0,
    revision: 0,
    rows: [],
    status: 'unavailable',
  }
  return renderToString(
    <OverlayPanel
      {...props}
      activity={activity}
      attachments={attachments}
      {...(props.terminalCapabilities === undefined
        ? {}
        : { terminalCapabilities: props.terminalCapabilities })}
      jobs={jobs}
      mcp={mcp}
      plugins={plugins}
      projections={projections}
      skills={skills}
      subagents={subagents}
      theme={props.theme ?? 'default'}
    />,
    { columns: props.columns },
  )
}
