import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import { DEFAULT_TIPS, Welcome } from './welcome'

function render(props: Partial<Parameters<typeof Welcome>[0]> = {}): string {
  const columns = props.columns ?? 80
  return renderToString(
    <Welcome
      columns={columns}
      cwd="/Users/dev/Code/project"
      modelLabel="deepseek-official/deepseek-chat"
      permission="workspace-write"
      theme="default"
      tips={DEFAULT_TIPS}
      version="0.2.0"
      {...props}
    />,
    { columns },
  )
}

describe('Welcome (M6)', () => {
  it('renders identity and guidance side by side at 80 columns', () => {
    expect(render()).toMatchSnapshot()
  })

  it('stacks the columns at 40 columns instead of squeezing them', () => {
    expect(render({ columns: 40 })).toMatchSnapshot()
  })

  it('caps its width on an ultra-wide terminal', () => {
    const wide = render({ columns: 200 })
    const longest = Math.max(...wide.split('\n').map(line => line.length))
    expect(longest).toBeLessThanOrEqual(100)
  })

  // Every tip names a key that exists; the panel is guidance, not decoration.
  it('shows each tip verbatim', () => {
    const output = render()
    for (const tip of DEFAULT_TIPS) {
      expect(output).toContain(tip.split('  ')[0])
    }
  })

  // Nothing is invented to fill the panel.
  it('omits facts the runtime does not have', () => {
    const bare = render({ modelLabel: undefined, permission: undefined })
    expect(bare).not.toContain('deepseek')
    expect(bare).not.toContain('workspace-write')
    expect(bare).toContain('dsh-tui')
    expect(bare).toContain('Getting started')
  })

  // The leaf directory identifies the workspace; the root rarely does.
  it('keeps the tail of a long workspace path', () => {
    const output = render({ cwd: `/very/deep/${'nested/'.repeat(12)}workspace-leaf` })
    expect(output).toContain('workspace-leaf')
  })

  it('drops box drawing in screen-reader mode without losing text', () => {
    const plain = render({ screenReader: true })
    expect(plain).not.toMatch(/[─-╿]/)
    expect(plain).toContain('dsh-tui')
    expect(plain).toContain('Getting started')
  })

  it('carries no information in color alone', () => {
    expect(render({ theme: 'no-color' })).toBe(render({ theme: 'default' }))
  })
})
