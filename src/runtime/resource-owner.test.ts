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

  it('M2.4-F08 continues disposal and reports every failure', async () => {
    const terminalDispose = vi.fn()
    const owner = new ResourceOwner()
    owner.own('terminal', terminalDispose)
    owner.own('first listener', () => {
      throw new Error('first listener failed')
    })
    owner.own('second listener', async () => {
      throw new Error('second listener failed')
    })

    let caught: unknown
    try {
      await owner.dispose()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect(caught).toMatchObject({
      errors: [
        expect.objectContaining({ message: 'Failed to dispose second listener' }),
        expect.objectContaining({ message: 'Failed to dispose first listener' }),
      ],
      message: 'One or more owned resources failed to dispose',
    })
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
