import { useSyncExternalStore } from 'react'
import { Box, Text, render } from 'ink'

import type { SessionCenterController } from '../model/session-center-controller'
import type {
  SessionAttachmentSnapshot,
  SwitchableSessionBinding,
} from '../runtime/session-attachment-coordinator'
import { InteractiveTui, type InteractiveTuiProps } from './app'
import { mountOwnedInkRenderer, type MountedInkRenderer } from './ink-lifecycle'

export interface TuiSessionBinding extends SwitchableSessionBinding {
  readonly application: Omit<InteractiveTuiProps, 'onQuit' | 'sessionCenter'>
}

export interface TuiSessionStore {
  readonly getSnapshot: () => SessionAttachmentSnapshot<TuiSessionBinding>
  readonly subscribe: (listener: () => void) => () => void
}

export interface InkApplicationOptions {
  /** No persisted session was found, so onboarding guidance is shown. */
  readonly firstRun?: boolean
  /** Terminal occupancy; `inline` leaves the session in scrollback. */
  readonly renderMode?: 'alternate' | 'inline'
  readonly onQuit: (code: number) => void
  readonly sessionCenter: SessionCenterController
  readonly sessions: TuiSessionStore
}

export type MountedInkApplication = MountedInkRenderer

export interface InkApplicationStreams {
  readonly stderr?: NodeJS.WriteStream
  readonly stdin?: NodeJS.ReadStream
  readonly stdout?: NodeJS.WriteStream
}

export function SessionApplication({
  firstRun = false,
  onQuit,
  sessionCenter,
  sessions,
}: InkApplicationOptions) {
  const snapshot = useSyncExternalStore(
    sessions.subscribe,
    sessions.getSnapshot,
    sessions.getSnapshot,
  )
  if (snapshot.binding === undefined || snapshot.status !== 'attached') {
    return (
      <Box flexDirection="column">
        <Text bold>dsh-tui · {snapshot.status}</Text>
        <Text dimColor wrap="truncate-end">
          {snapshot.targetSessionId === undefined
            ? (snapshot.error ?? 'No session is attached.')
            : `Switching to ${snapshot.targetSessionId}…`}
        </Text>
      </Box>
    )
  }
  return <InteractiveTui
    key={`${snapshot.binding.sessionId}:${String(snapshot.revision)}`}
    {...snapshot.binding.application}
    firstRun={firstRun}
    {...(snapshot.error === undefined
      ? {}
      : { initialNotice: `Session switch failed: ${snapshot.error}` })}
    onQuit={onQuit}
    sessionCenter={sessionCenter}
  />
}

export function mountInkApplication(
  options: InkApplicationOptions,
  streams: InkApplicationStreams = {},
): MountedInkApplication {
  const stdout = streams.stdout ?? process.stdout
  // Read once at mount: switching buffers under a live render would strand
  // whatever was already drawn in the buffer being left behind.
  const alternateScreen = options.renderMode !== 'inline'
  return mountOwnedInkRenderer(
    () => render(<SessionApplication {...options} />, {
      alternateScreen,
      exitOnCtrlC: false,
      incrementalRendering: true,
      interactive: true,
      maxFps: 20,
      stderr: streams.stderr ?? process.stderr,
      stdin: streams.stdin ?? process.stdin,
      stdout,
    }),
    stdout,
  )
}
