import { describe, expect, it, vi } from 'vitest'

import { RecoveryController } from './recovery-controller'

function fixture(overrides: {
  readonly exportRaw?: (destination: string, signal: AbortSignal) => Promise<{ codeUnits: number, path: string }>
  readonly flush?: (signal: AbortSignal) => Promise<boolean>
  readonly fork?: (signal: AbortSignal) => Promise<{ boundary: number, sessionId: string }>
} = {}) {
  const flush = vi.fn(overrides.flush ?? (async () => true))
  const fork = vi.fn(overrides.fork ?? (async () => ({ boundary: 7, sessionId: 'child' })))
  const exportRaw = overrides.exportRaw === undefined
    ? undefined
    : vi.fn(overrides.exportRaw)
  const controller = new RecoveryController({
    operations: {
      ...(exportRaw === undefined ? {} : { exportRaw }),
      flush,
      fork,
    },
    sessionId: 'parent',
    suggestedExportDestination: 'parent.jsonl',
  })
  return { controller, exportRaw, flush, fork }
}

describe('RecoveryController (M2.3)', () => {
  it('keeps durability, export, fork, and file rewind as separate capabilities', () => {
    const mounted = fixture()
    expect(mounted.controller.getSnapshot().capabilities).toEqual([
      expect.objectContaining({ available: true, id: 'durability' }),
      expect.objectContaining({ available: false, id: 'export' }),
      expect.objectContaining({ available: true, id: 'fork' }),
      expect.objectContaining({ available: false, id: 'file-rewind' }),
    ])
    expect(mounted.controller.getSnapshot().capabilities[3]?.detail).toContain('rc.6')
  })

  it('awaits the exact durability barrier and exposes missing listeners', async () => {
    const mounted = fixture()
    expect(mounted.controller.activateSelected()).toBe('started')
    await vi.waitFor(() => expect(mounted.controller.getSnapshot()).toMatchObject({
      result: 'Durable session barrier completed.',
      status: 'success',
    }))
    expect(mounted.flush).toHaveBeenCalledWith(expect.any(AbortSignal))

    const missing = fixture({ flush: async () => false })
    missing.controller.activateSelected()
    await vi.waitFor(() => expect(missing.controller.getSnapshot()).toMatchObject({
      error: expect.stringContaining('No durability listener'),
      status: 'error',
    }))
  })

  it('collects a bounded destination and exports without overwriting implicitly', async () => {
    const mounted = fixture({
      exportRaw: async destination => ({ codeUnits: 42, path: `/workspace/${destination}` }),
    })
    mounted.controller.move('down')
    expect(mounted.controller.activateSelected()).toBe('input-required')
    expect(mounted.controller.insertDestination('copy.jsonl')).toBe('applied')
    expect(mounted.controller.confirm()).toBe(true)
    await vi.waitFor(() => expect(mounted.controller.getSnapshot()).toMatchObject({
      result: 'Exported 42 code units to /workspace/copy.jsonl',
      status: 'success',
    }))
    expect(mounted.exportRaw).toHaveBeenCalledWith('copy.jsonl', expect.any(AbortSignal))

    const bounded = new RecoveryController({
      maxDestinationCodeUnits: 3,
      operations: {
        exportRaw: async () => ({ codeUnits: 0, path: 'x' }),
        flush: async () => true,
        fork: async () => ({ boundary: 0, sessionId: 'child' }),
      },
      sessionId: 'parent',
      suggestedExportDestination: 'parent.jsonl',
    })
    bounded.move('down')
    bounded.activateSelected()
    expect(bounded.insertDestination('four')).toBe('limit-exceeded')
  })

  it('M2.4-F05 contains an export failure and permits an explicit retry', async () => {
    let attempt = 0
    const mounted = fixture({
      exportRaw: async destination => {
        attempt += 1
        if (attempt === 1) throw new Error('backend read failed')
        return { codeUnits: 5, path: `/workspace/${destination}` }
      },
    })
    mounted.controller.move('down')
    mounted.controller.activateSelected()
    mounted.controller.insertDestination('retry.jsonl')
    mounted.controller.confirm()
    await vi.waitFor(() => expect(mounted.controller.getSnapshot()).toMatchObject({
      error: 'backend read failed',
      status: 'error',
    }))

    expect(mounted.controller.activateSelected()).toBe('input-required')
    mounted.controller.insertDestination('retry.jsonl')
    mounted.controller.confirm()
    await vi.waitFor(() => expect(mounted.controller.getSnapshot()).toMatchObject({
      result: 'Exported 5 code units to /workspace/retry.jsonl',
      status: 'success',
    }))
    expect(mounted.exportRaw).toHaveBeenCalledTimes(2)
  })

  it('requires explicit fork confirmation and reports the transferred boundary', async () => {
    const mounted = fixture()
    mounted.controller.move('down')
    mounted.controller.move('down')
    expect(mounted.controller.activateSelected()).toBe('confirmation-required')
    expect(mounted.controller.getSnapshot().status).toBe('confirming-fork')
    expect(mounted.controller.cancelMode()).toBe(true)
    expect(mounted.fork).not.toHaveBeenCalled()

    mounted.controller.activateSelected()
    expect(mounted.controller.confirm()).toBe(true)
    await vi.waitFor(() => expect(mounted.controller.getSnapshot()).toMatchObject({
      result: 'Forking child at event 7…',
      status: 'success',
    }))
  })

  it('aborts and awaits owned work during disposal', async () => {
    let observedSignal: AbortSignal | undefined
    const mounted = fixture({
      flush: signal => new Promise((_resolve, reject) => {
        observedSignal = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    mounted.controller.activateSelected()
    const disposal = mounted.controller.dispose()
    expect(observedSignal?.aborted).toBe(true)
    await disposal
    expect(() => mounted.controller.activateSelected()).toThrow('disposed')
  })

  it('cancels a running operation through its owned abort signal', async () => {
    const mounted = fixture({
      flush: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    mounted.controller.activateSelected()
    expect(mounted.controller.cancelOperation()).toBe(true)
    await vi.waitFor(() => expect(mounted.controller.getSnapshot()).toMatchObject({
      error: 'Recovery operation cancelled',
      status: 'error',
    }))
    expect(mounted.controller.cancelOperation()).toBe(false)
  })
})
