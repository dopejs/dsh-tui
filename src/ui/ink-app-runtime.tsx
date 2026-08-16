import { render } from 'ink'

import type { AgentStatusStore } from '../model/agent-status-controller'
import type { CommandPaletteController } from '../model/command-palette-controller'
import type { CompletionController } from '../model/completion-controller'
import type { EditorController } from '../model/editor-controller'
import type { InteractionController } from '../model/interaction-controller'
import type { OverlayController } from '../model/overlay-controller'
import type { TranscriptStore } from '../model/transcript-controller'
import type { TranscriptViewportController } from '../model/transcript-viewport-controller'
import type { InputController } from '../runtime/input-controller'
import { InteractiveTui } from './app'

export interface InkApplicationOptions {
  readonly completion: CompletionController
  readonly editor: EditorController
  readonly input: InputController
  readonly interaction: InteractionController
  readonly modelLabel: string
  readonly onQuit: (code: number) => void
  readonly overlay: OverlayController
  readonly palette: CommandPaletteController
  readonly sessionId: string
  readonly status: AgentStatusStore
  readonly transcript: TranscriptStore
  readonly viewport: TranscriptViewportController
  readonly workspace: string
}

export interface MountedInkApplication {
  readonly exited: Promise<void>
  dispose(): Promise<void>
}

export function mountInkApplication(options: InkApplicationOptions): MountedInkApplication {
  const renderer = render(<InteractiveTui {...options} />, {
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
