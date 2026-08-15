import { describe, expect, it, vi } from 'vitest'

import { ResourceOwner } from './resource-owner'

describe('ResourceOwner', () => {
  it('disposes resources once in reverse acquisition order', async () => {
    const calls: string[] = []
    const owner = new ResourceOwner()
    owner.own('terminal', () => {
      calls.push('terminal')
    })
    owner.own('listener', async () => {
      await Promise.resolve()
      calls.push('listener')
    })

    await Promise.all([owner.dispose(), owner.dispose()])

    expect(calls).toEqual(['listener', 'terminal'])
  })

  it('continues disposal and reports every failure', async () => {
    const terminalDispose = vi.fn()
    const owner = new ResourceOwner()
    owner.own('terminal', terminalDispose)
    owner.own('listener', () => {
      throw new Error('listener failed')
    })

    await expect(owner.dispose()).rejects.toThrow('One or more owned resources failed')
    expect(terminalDispose).toHaveBeenCalledOnce()
  })

  it('rejects acquisition after disposal begins', async () => {
    const owner = new ResourceOwner()
    await owner.dispose()

    expect(() => {
      owner.own('late listener', () => undefined)
    }).toThrow('resource owner is closing')
  })
})
