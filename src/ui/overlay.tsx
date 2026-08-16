import { Box, Text, renderToString } from 'ink'

import type { ChangeIndexSnapshot, IndexedChange } from '../model/change-index-controller'
import type { CommandPaletteSnapshot } from '../model/command-palette-controller'
import type { CompletionSnapshot } from '../model/completion-controller'
import type { OverlayKind } from '../model/overlay-controller'
import type { PermissionSnapshot } from '../model/permission-controller'
import type { SessionCenterSnapshot } from '../model/session-center-controller'

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
  readonly changes: ChangeIndexSnapshot
  readonly columns: number
  readonly completion: CompletionSnapshot
  readonly maxRows: number
  readonly palette: CommandPaletteSnapshot
  readonly permissions: PermissionSnapshot
  readonly sessions: SessionCenterSnapshot
}

export function OverlayPanel({
  active,
  changes,
  columns,
  completion,
  maxRows,
  palette,
  permissions,
  sessions,
}: OverlayPanelProps) {
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
      <Box borderStyle="round" flexDirection="column" width={Math.max(4, columns)}>
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
              {isSelected ? '›' : ' '} {item.change.expanded ? '▾' : '▸'} {item.change.path}
              {item.groupCount > 1 ? ` [${String(item.groupIndex + 1)}/${String(item.groupCount)}]` : ''}
              {' · '}{item.change.phase}{' · '}{item.change.title}
            </Text>
          )
        })}
        {detail === undefined ? null : detail.lines.map((line, index) => (
          <Text
            {...diffLineColor(line)}
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
      <Box borderStyle="round" flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">Command palette</Text>
        <Text wrap="truncate-end">
          &gt; {palette.query}<Text inverse>█</Text>
        </Text>
        {palette.error === undefined ? null : (
          <Text color="red" wrap="truncate-end">{palette.error}</Text>
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
      <Box borderStyle="round" flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">Session center · {sessions.status}</Text>
        <Text wrap="truncate-end">
          &gt; {sessions.query}<Text inverse>█</Text>
        </Text>
        {sessions.error === undefined ? null : (
          <Text color="red" wrap="truncate-end">{sessions.error}</Text>
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
      <Box borderStyle="round" flexDirection="column" width={Math.max(4, columns)}>
        <Text bold wrap="truncate-end">Permissions · {permissions.status}</Text>
        {permissions.status === 'confirming' ? (
          <>
            <Text color="red" wrap="truncate-end">
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
          <Text color="red" wrap="truncate-end">{permissions.error}</Text>
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
    <Box borderStyle="round" flexDirection="column" width={Math.max(4, columns)}>
      <Text bold wrap="truncate-end">{kind} completion · {completion.query}</Text>
      {completion.status === 'loading' ? <Text dimColor>Loading…</Text> : null}
      {completion.error === undefined ? null : (
        <Text color="red" wrap="truncate-end">{completion.error}</Text>
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

function diffLineColor(line: string): Readonly<{ color: 'green' | 'red' }> | Readonly<Record<string, never>> {
  if (line.startsWith('+++') || line.startsWith('+ ')) return { color: 'green' }
  if (line.startsWith('---') || line.startsWith('- ')) return { color: 'red' }
  return {}
}

function textLines(value: string | null): readonly string[] {
  return value === null || value === '' ? [] : value.split('\n')
}

export function renderOverlayPanel(
  props: OverlayPanelProps,
): string {
  return renderToString(<OverlayPanel {...props} />, { columns: props.columns })
}
