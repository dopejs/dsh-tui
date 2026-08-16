import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import type { SessionCenterController } from '../model/session-center-controller'
import type { SessionAttachmentSnapshot } from '../runtime/session-attachment-coordinator'
import {
  SessionApplication,
  type TuiSessionBinding,
  type TuiSessionStore,
} from './ink-app-runtime'

function renderTransition(snapshot: SessionAttachmentSnapshot<TuiSessionBinding>): string {
  const sessions: TuiSessionStore = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  }
  return renderToString(<SessionApplication
    onQuit={() => undefined}
    sessionCenter={{} as SessionCenterController}
    sessions={sessions}
  />, { columns: 60 })
}

describe('SessionApplication (M1.4)', () => {
  it('renders the input-blocking switch transition at a fixed width', () => {
    expect(renderTransition({
      revision: 1,
      status: 'switching',
      targetSessionId: 'target-session',
    })).toMatchSnapshot()
  })

  it('renders an unrecoverable attachment failure at a fixed width', () => {
    expect(renderTransition({
      error: 'The previous session could not be restored.',
      revision: 2,
      status: 'failed',
    })).toMatchSnapshot()
  })
})
