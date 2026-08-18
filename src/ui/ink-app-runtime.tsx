import { useSyncExternalStore } from 'react'
import { Box, Text, render } from 'ink'

import type { SessionCenterController } from '../model/session-center-controller'
import type {
  SessionAttachmentSnapshot,
  SwitchableSessionBinding,
} from '../runtime/session-attachment-coordinator'
import { DISABLE_MOUSE, ENABLE_MOUSE } from '../runtime/mouse'
import { filterMouseFromStdin, type MouseFilteredStdin } from '../runtime/mouse-stdin'
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
  /** Decoded mouse events, when the terminal was asked to report them. */
  readonly mouse?: MouseFilteredStdin
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
  mouse,
  onQuit,
  renderMode = 'alternate',
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
    {...(mouse === undefined ? {} : { mouse })}
    renderMode={renderMode}
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
  const stdin = streams.stdin ?? process.stdin
  // Read once at mount: switching buffers under a live render would strand
  // whatever was already drawn in the buffer being left behind.
  const alternateScreen = options.renderMode !== 'inline'

  // Mouse reporting is asked for only when there is a terminal to ask. Writing
  // the sequence to a pipe puts it in whatever is consuming the output.
  const interactive = stdin.isTTY === true && stdout.isTTY === true
  const mouse = interactive ? filterMouseFromStdin(stdin) : undefined
  if (mouse !== undefined) stdout.write(ENABLE_MOUSE)

  const mounted = mountOwnedInkRenderer(
    () => render(
      <SessionApplication {...options} {...(mouse === undefined ? {} : { mouse })} />,
      {
        alternateScreen,
        exitOnCtrlC: false,
        incrementalRendering: true,
        interactive: true,
        maxFps: 20,
        stderr: streams.stderr ?? process.stderr,
        stdin: mouse?.stream ?? stdin,
        stdout,
      },
    ),
    stdout,
  )

  if (mouse === undefined) return mounted
  /*
   * Reporting must stop before the process does: a terminal left reporting
   * prints escape sequences into the user's shell on every click afterwards.
   *
   * Order is the whole of this. Feeding stops first, so the renderer unmounts
   * against a quiet stream; the stream itself is closed only afterwards,
   * because ending it under a live renderer is something a renderer reading it
   * notices -- that left the installed TUI unable to exit at all.
   */
  return Object.freeze({
    ...mounted,
    dispose: async () => {
      try {
        stdout.write(DISABLE_MOUSE)
      } catch {
        // A closed stdout is already being reported through `exited`.
      }
      mouse.detach()
      try {
        await mounted.dispose()
      } finally {
        mouse.dispose()
      }
    },
  })
}
