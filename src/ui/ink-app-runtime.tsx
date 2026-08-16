import { useSyncExternalStore } from 'react'
import { Box, Text, render } from 'ink'

import type { SessionCenterController } from '../model/session-center-controller'
import type {
  SessionAttachmentSnapshot,
  SwitchableSessionBinding,
} from '../runtime/session-attachment-coordinator'
import { InteractiveTui, type InteractiveTuiProps } from './app'

export interface TuiSessionBinding extends SwitchableSessionBinding {
  readonly application: Omit<InteractiveTuiProps, 'onQuit' | 'sessionCenter'>
}

export interface TuiSessionStore {
  readonly getSnapshot: () => SessionAttachmentSnapshot<TuiSessionBinding>
  readonly subscribe: (listener: () => void) => () => void
}

export interface InkApplicationOptions {
  readonly onQuit: (code: number) => void
  readonly sessionCenter: SessionCenterController
  readonly sessions: TuiSessionStore
}

export interface MountedInkApplication {
  readonly exited: Promise<void>
  dispose(): Promise<void>
}

export function SessionApplication({ onQuit, sessionCenter, sessions }: InkApplicationOptions) {
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
    {...(snapshot.error === undefined
      ? {}
      : { initialNotice: `Session switch failed: ${snapshot.error}` })}
    onQuit={onQuit}
    sessionCenter={sessionCenter}
  />
}

export function mountInkApplication(options: InkApplicationOptions): MountedInkApplication {
  const renderer = render(<SessionApplication {...options} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    interactive: true,
    maxFps: 20,
  })
  const exited = renderer.waitUntilExit().then(() => undefined)
  let disposing: Promise<void> | undefined
  return {
    exited,
    dispose() {
      disposing ??= (async () => {
        renderer.unmount()
        await exited
      })()
      return disposing
    },
  }
}
