import { describe, expect, it } from 'vitest'

import {
  filterByWorkspace,
  groupByWorkspace,
  normalizeRoot,
  relaunchHintFor,
} from './workspace-filter'

const session = (id: string, cwd?: string) => ({ id, ...(cwd === undefined ? {} : { cwd }) })

describe('workspace grouping (M5.4)', () => {
  it('normalizes separators and trailing slashes without touching the disk', () => {
    expect(normalizeRoot('/repo/main/')).toBe('/repo/main')
    expect(normalizeRoot('/repo/main///')).toBe('/repo/main')
    expect(normalizeRoot('C:\\repo\\main')).toBe('C:/repo/main')
    expect(normalizeRoot('/')).toBe('/')
    expect(normalizeRoot('')).toBe('/')
  })

  it('groups sessions by the root they were started in', () => {
    const result = groupByWorkspace([
      session('a', '/repo/main'),
      session('b', '/repo/main/'),
      session('c', '/other/project'),
    ])
    expect(result.groups).toEqual([
      { count: 1, label: 'project', root: '/other/project' },
      { count: 2, label: 'main', root: '/repo/main' },
    ])
    expect(result.unknownCount).toBe(0)
  })

  // Two worktrees of one repository share a leaf name; collapsing both to
  // `feature` would make the list useless exactly where it matters.
  it('falls back to the full root when leaf names collide', () => {
    const result = groupByWorkspace([
      session('a', '/repo/wt-1/feature'),
      session('b', '/repo/wt-2/feature'),
      session('c', '/repo/main'),
    ])
    expect(result.groups.map(group => group.label)).toEqual([
      'main',
      '/repo/wt-1/feature',
      '/repo/wt-2/feature',
    ])
  })

  it('counts sessions that carry no workspace separately', () => {
    const result = groupByWorkspace([session('a'), session('b', ''), session('c', '/repo')])
    expect(result.unknownCount).toBe(2)
    expect(result.groups).toHaveLength(1)
  })

  it('handles an empty listing', () => {
    expect(groupByWorkspace([])).toEqual({ groups: [], unknownCount: 0 })
  })

  it('bounds a pathological root label', () => {
    const deep = `/${'x'.repeat(1_000)}`
    const [group] = groupByWorkspace([session('a', deep)]).groups
    expect(group?.label.length).toBeLessThanOrEqual(300)
    expect(group?.root).toBe(deep)
  })
})

describe('workspace filtering (M5.4)', () => {
  it('returns every session when no root is selected', () => {
    const sessions = [session('a', '/repo'), session('b')]
    expect(filterByWorkspace(sessions, undefined)).toBe(sessions)
  })

  it('keeps only the sessions recorded in the selected root', () => {
    const sessions = [
      session('a', '/repo/main'),
      session('b', '/repo/main/'),
      session('c', '/other'),
    ]
    expect(filterByWorkspace(sessions, '/repo/main').map(entry => entry.id)).toEqual(['a', 'b'])
    expect(filterByWorkspace(sessions, '/repo/main/').map(entry => entry.id)).toEqual(['a', 'b'])
  })

  // Including them would make the filter mean "this root, plus anything we
  // could not place", which is not what the user selected.
  it('excludes sessions that cannot be proven to belong to the root', () => {
    expect(filterByWorkspace([session('a'), session('b', '/repo')], '/repo')
      .map(entry => entry.id)).toEqual(['b'])
  })

  it('returns nothing for an unknown root rather than falling back to everything', () => {
    expect(filterByWorkspace([session('a', '/repo')], '/missing')).toEqual([])
  })
})

describe('workspace transitions (M5.4)', () => {
  // The TUI runs inside an already-composed process; re-rooting it would
  // invalidate every live handle, so the launcher owns the transition.
  it('reports the relaunch a workspace change needs instead of performing it', () => {
    expect(relaunchHintFor('/repo/wt-2/feature/'))
      .toBe('Start dsh from /repo/wt-2/feature to work in that worktree.')
  })
})
