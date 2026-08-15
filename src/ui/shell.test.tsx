import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { Shell } from './shell.js'

describe('Shell', () => {
  it('renders the fixed-size empty lifecycle shell', () => {
    expect(renderToString(<Shell onQuit={() => undefined} />, { columns: 60 }))
      .toMatchInlineSnapshot(`
        "dsh-tui
        Milestone 1 lifecycle shell
        new session (agent attachment not implemented)
        Press q or Ctrl-C to exit."
      `)
  })

  it('makes the requested resume id visible', () => {
    expect(
      renderToString(<Shell onQuit={() => undefined} resumeSessionId="session-1" />, {
        columns: 60,
      }),
    ).toContain('resume session-1')
  })
})
