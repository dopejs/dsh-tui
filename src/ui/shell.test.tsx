import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { Shell } from './shell'

describe('Shell', () => {
  it('renders the fixed-size empty lifecycle shell', () => {
    expect(renderToString(<Shell onQuit={() => undefined} />, { columns: 60 }))
      .toMatchInlineSnapshot(`
        "dsh-tui
        Standalone terminal lifecycle fixture
        fresh-session terminal path
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
