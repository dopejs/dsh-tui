import { useSyncExternalStore } from 'react'
import { Box, Text, render } from 'ink'

import type { SessionCenterController } from '../model/session-center-controller'
import type {
  SessionAttachmentSnapshot,
  SwitchableSessionBinding,
} from '../runtime/session-attachment-coordinator'
import { appendFileSync } from 'node:fs'

import { DISABLE_MOUSE, ENABLE_MOUSE } from '../runtime/mouse'
import { probeKittySupport } from '../runtime/kitty'
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
  /**
   * Whether the terminal speaks the Kitty keyboard protocol, already probed.
   * Absent means it does not, and Shift-Enter cannot be told from Enter.
   */
  readonly kittyKeyboard?: boolean
  /** The stdin filter, when one was already made by the capability probe. */
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

interface SessionApplicationProps extends Omit<InkApplicationOptions, 'mouse'> {
  readonly mouse?: InteractiveTuiProps['mouse']
}

export function SessionApplication({
  firstRun = false,
  mouse,
  onQuit,
  renderMode = 'alternate',
  sessionCenter,
  sessions,
}: SessionApplicationProps) {
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

/**
 * Probe the terminal for the Kitty keyboard protocol.
 *
 * Done before mounting, through the filter that already owns stdin, so the
 * reply is stripped rather than typed and nothing is listening for keystrokes
 * while the question is outstanding.
 */
export async function probeTerminalKeyboard(
  streams: InkApplicationStreams = {},
): Promise<{ readonly mouse?: MouseFilteredStdin, readonly kittyKeyboard: boolean }> {
  const stdin = streams.stdin ?? process.stdin
  const stdout = streams.stdout ?? process.stdout
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    return Object.freeze({ kittyKeyboard: false })
  }
  /*
   * Raw mode first.
   *
   * A terminal in canonical mode delivers input a line at a time, and a
   * capability reply carries no newline -- so it sat in the line buffer and
   * never arrived, the probe timed out, and the protocol stayed off on
   * terminals that had answered. Ink sets raw mode again when it mounts;
   * setting it twice costs nothing.
   */
  stdin.setRawMode?.(true)
  const mouse = filterMouseFromStdin(stdin)
  const kittyKeyboard = await probeKittySupport({
    onData: mouse.onRaw,
    write: text => stdout.write(text),
  })
  return Object.freeze({ kittyKeyboard, mouse })
}

/** Where the runtime already writes diagnostics, when it was asked to. */
const diagnosticLog = process.env.DSH_TUI_LOG_FILE

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
  const mouse = options.mouse ?? (interactive ? filterMouseFromStdin(stdin) : undefined)
  /*
   * Reporting can be given back.
   *
   * While a terminal is reporting, it hands mouse events to this process
   * instead of making a selection of its own, so dragging no longer selects
   * text. Most terminals let Shift bypass that, but not every one does and
   * nobody should have to know -- so it can simply be turned off, at which
   * point selection behaves exactly as it did before any of this existed.
   */
  let reporting = false
  const setReporting = (enabled: boolean) => {
    if (enabled === reporting) return
    reporting = enabled
    const wrote = stdout.write(enabled ? ENABLE_MOUSE : DISABLE_MOUSE)
    if (diagnosticLog !== undefined) {
      appendFileSync(diagnosticLog, `[mouse pid=${String(process.pid)}]`
        + ` setReporting(${String(enabled)}) wrote=${String(wrote)}\n`)
    }
  }
  const mouseProp = mouse === undefined
    ? undefined
    : { onMouse: mouse.onMouse, setReporting }

  const mounted = mountOwnedInkRenderer(
    () => render(
      <SessionApplication
        {...options}
        mouse={mouseProp}
      />,
      {
        alternateScreen,
        exitOnCtrlC: false,
        incrementalRendering: true,
        interactive: true,
        /*
         * `enabled` or `disabled`, never `auto`. Ink's own negotiation buffers
         * stdin for up to 200ms and then pushes what it buffered back into the
         * input pipeline, where the application is already listening -- so
         * anything typed in that window arrives twice. The answer is probed
         * before mounting instead, while nothing is listening for keystrokes.
         */
        kittyKeyboard: {
          flags: ['disambiguateEscapeCodes'],
          mode: options.kittyKeyboard === true ? 'enabled' : 'disabled',
        },
        maxFps: 20,
        stderr: streams.stderr ?? process.stderr,
        stdin: mouse?.stream ?? stdin,
        stdout,
      },
    ),
    stdout,
  )

  /*
   * Recorded, because "the mouse does nothing" and "the mouse was never asked
   * for" look identical from outside and the second is a defect here rather
   * than in the terminal. Written to the diagnostic log the runtime already
   * owns, so it costs nothing when no one is looking.
   */
  if (diagnosticLog !== undefined) {
    // Attributed by process: the log outlives one run, and a line that cannot
    // be tied to the run being asserted about explains nothing.
    appendFileSync(diagnosticLog, `[mouse pid=${String(process.pid)}]`
      + ` filter=${String(mouse !== undefined)}`
      + ` stdinTTY=${String(stdin.isTTY === true)} stdoutTTY=${String(stdout.isTTY === true)}\n`)
  }
  if (mouse === undefined) return mounted

  /*
   * Asked for after the renderer has taken the alternate screen, not before.
   *
   * Terminals keep private mode state per screen buffer, so a mode set on the
   * primary screen is not in effect once the alternate one is entered. Set
   * first, reporting was discarded on a real terminal -- Ghostty reported
   * nothing at all -- while the emulator the screen tests run against does not
   * separate the buffers and kept it, so every test stayed green.
   */
  setReporting(true)
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
