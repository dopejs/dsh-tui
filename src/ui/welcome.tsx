import { Box, Text } from 'ink'

import type { TuiTheme } from '../model/preferences-controller'
import { toneStyle } from './theme'

export interface WelcomeProps {
  readonly columns: number
  /** Absolute workspace path; shown as-is because it is what the agent acts on. */
  readonly cwd: string
  /** Absent until the runtime resolves one; the panel omits it rather than guess. */
  readonly modelLabel?: string | undefined
  readonly permission?: string | undefined
  /** Drop box drawing for screen readers. */
  readonly screenReader?: boolean
  readonly theme: TuiTheme
  readonly tips: readonly string[]
  readonly version: string
}

/** Keep the panel legible instead of letting it span an ultra-wide terminal. */
const MAX_WIDTH = 100
/** Below this, the two columns are stacked rather than squeezed. */
const TWO_COLUMN_MIN = 72

function shorten(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  // Keep the tail: the leaf directory identifies the workspace, the root rarely does.
  return `…${value.slice(value.length - maximum + 1)}`
}

/**
 * The first screen of a session.
 *
 * It exists because an empty transcript tells a new user nothing — not what
 * model is answering, not where the agent is working, not how to reach
 * anything. Every value shown is one the runtime actually has; nothing is
 * invented to fill the panel.
 */
export function Welcome({
  columns,
  cwd,
  modelLabel,
  permission,
  screenReader = false,
  theme,
  tips,
  version,
}: WelcomeProps) {
  const tone = (name: Parameters<typeof toneStyle>[1]) => toneStyle(theme, name)
  const width = Math.max(20, Math.min(columns, MAX_WIDTH))
  const frame = screenReader ? {} : { borderStyle: 'round' as const }
  const stacked = width < TWO_COLUMN_MIN
  const identity = (
    <Box flexDirection="column" {...(stacked ? {} : { width: Math.floor(width / 2) - 2 })}>
      <Text bold>dsh-tui <Text {...tone('muted')}>v{version}</Text></Text>
      {modelLabel === undefined
        ? null
        : <Text {...tone('accent')} wrap="truncate-end">{modelLabel}</Text>}
      {permission === undefined
        ? null
        : <Text {...tone('muted')} wrap="truncate-end">{permission}</Text>}
      <Text {...tone('muted')} wrap="truncate-end">
        {shorten(cwd, Math.max(12, (stacked ? width : Math.floor(width / 2)) - 4))}
      </Text>
    </Box>
  )
  const guidance = (
    <Box flexDirection="column" {...(stacked ? {} : { width: Math.floor(width / 2) - 2 })}>
      <Text {...tone('accent')}>Getting started</Text>
      {tips.map(tip => (
        <Text key={tip} wrap="truncate-end">{tip}</Text>
      ))}
    </Box>
  )

  return (
    <Box {...frame} flexDirection="column" paddingX={1} width={width}>
      {stacked ? (
        <Box flexDirection="column">
          {identity}
          <Box height={1} />
          {guidance}
        </Box>
      ) : (
        <Box flexDirection="row" gap={2}>
          {identity}
          {guidance}
        </Box>
      )}
    </Box>
  )
}

/** The default first-run guidance. Each line names a key that actually works. */
export const DEFAULT_TIPS: readonly string[] = Object.freeze([
  '^P  command palette — every action is here',
  '^Y  activity · ^B jobs · ^G subagents',
  '/exit  quit with a durable teardown',
])
