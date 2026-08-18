import { describe, expect, it } from 'vitest'

import { compare, skewAction } from '../../bin/version-skew.js'

describe('compare (launcher)', () => {
  it('orders by release core', () => {
    expect(compare('0.1.0', '0.2.2')).toBe(-1)
    expect(compare('0.2.2', '0.1.0')).toBe(1)
    expect(compare('0.2.2', '0.2.2')).toBe(0)
  })

  it('orders a prerelease before its release', () => {
    expect(compare('0.2.0-rc.1', '0.2.0')).toBe(-1)
    expect(compare('0.2.0', '0.2.0-rc.1')).toBe(1)
  })
})

describe('skewAction (launcher)', () => {
  it('installs on first run', () => {
    expect(skewAction(undefined, '0.2.2'))
      .toEqual({ action: 'install', reason: 'first-run' })
  })

  it('starts an aligned profile', () => {
    expect(skewAction('0.2.2', '0.2.2'))
      .toEqual({ action: 'start', reason: 'aligned' })
  })

  // `npm i -g` upgrades the launcher and moves nothing else, so this fires on
  // every upgrade. Printing a command for the user to retype is a chore, not a
  // safeguard: the launcher knows the one action that fixes it.
  it('realigns a profile left behind by an upgrade instead of refusing', () => {
    const result = skewAction('0.1.0', '0.2.2')
    expect(result).toEqual({ action: 'install', reason: 'profile-behind' })
  })

  // Downgrading would overrule a deliberate install; the newer package brings
  // its own composition and can start on its own terms.
  it('starts a profile that is ahead rather than downgrading it', () => {
    expect(skewAction('0.3.0', '0.2.2'))
      .toEqual({ action: 'start', reason: 'profile-ahead' })
  })

  // Starting a behind profile applies this launcher's bundle patch to the
  // older package and fails on module resolution. It must never be 'start'.
  it('never starts a profile that is behind', () => {
    for (const present of ['0.1.0', '0.2.1', '0.2.2-rc.1', '0.0.1']) {
      expect(`${present}:${skewAction(present, '0.2.2').action}`)
        .toBe(`${present}:install`)
    }
  })
})
