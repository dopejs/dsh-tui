import type {
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from '@deepseek-ai/dsh-host-plugin-inventory'
import { describe, expect, it, vi } from 'vitest'

import { PluginInventoryController, type PluginInventorySource } from './plugin-inventory-controller'

function entry(
  entryId: string,
  overrides: Partial<PluginInventoryEntry> = {},
): PluginInventoryEntry {
  return {
    enabled: true,
    entryId,
    fiberPhase: 'active',
    moduleName: `@scope/${entryId}`,
    ...overrides,
  } as PluginInventoryEntry
}

class FakeInventory implements PluginInventorySource {
  readonly list = vi.fn<() => PluginInventorySnapshot>(() => ({ entries: [] }))
}

function changeSignal() {
  const listeners = new Set<() => void>()
  let unsubscribes = 0
  return {
    emit: () => {
      for (const listener of [...listeners]) listener()
    },
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        unsubscribes += 1
        listeners.delete(listener)
      }
    },
    get unsubscribes() {
      return unsubscribes
    },
  }
}

describe('PluginInventoryController (M4.4)', () => {
  // dsh-base does not mount the inventory gateway, so absent is the usual case.
  it('is unavailable without the inventory and invents no entries', () => {
    const controller = new PluginInventoryController()
    expect(controller.getSnapshot()).toMatchObject({ rows: [], status: 'unavailable' })
    expect(controller.refresh()).toBe(false)
    controller.dispose()
  })

  // Toggling an entry means writing the Loader tree or the profile document,
  // and neither is a public transaction on this baseline.
  it('reports mutation as unavailable and exposes no toggle', () => {
    const controller = new PluginInventoryController(new FakeInventory())
    expect(controller.getSnapshot().mutation).toBe('read-only-no-public-transaction')
    expect('enable' in controller).toBe(false)
    expect('disable' in controller).toBe(false)
    expect('toggle' in controller).toBe(false)
    controller.dispose()
  })

  it('projects enablement, fiber phase, and module for each entry', () => {
    const inventory = new FakeInventory()
    inventory.list.mockReturnValue({
      entries: [
        entry('a'),
        entry('b', { enabled: false, fiberPhase: null }),
        entry('c', { fiberPhase: 'loading' }),
      ],
    })
    const controller = new PluginInventoryController(inventory)

    const snapshot = controller.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.rows).toEqual([
      { enabled: true, entryId: 'a', fiberPhase: 'active', moduleName: '@scope/a' },
      { enabled: false, entryId: 'b', fiberPhase: 'none', moduleName: '@scope/b' },
      { enabled: true, entryId: 'c', fiberPhase: 'loading', moduleName: '@scope/c' },
    ])
    controller.dispose()
  })

  it('reports failed fibers as diagnostics without inventing a cause', () => {
    const inventory = new FakeInventory()
    inventory.list.mockReturnValue({
      entries: [
        entry('ok'),
        entry('broken', { fiberPhase: 'failed' }),
        entry('off', { enabled: false, fiberPhase: 'failed' }),
      ],
    })
    const controller = new PluginInventoryController(inventory)

    const snapshot = controller.getSnapshot()
    expect(snapshot.failedCount).toBe(2)
    expect(snapshot.diagnostics.map(d => d.entryId)).toEqual(['broken', 'off'])
    expect(snapshot.diagnostics[0]?.summary).toContain('failed to load')
    expect(snapshot.diagnostics[1]?.summary).toContain('Disabled entry')
    controller.dispose()
  })

  // A newer Loader may add a phase this build does not know; reporting it
  // verbatim beats collapsing it into a phase that means something else.
  it('preserves an unrecognized fiber phase rather than coercing it', () => {
    const inventory = new FakeInventory()
    inventory.list.mockReturnValue({
      entries: [entry('future', { fiberPhase: 'quiescing' as never })],
    })
    const controller = new PluginInventoryController(inventory)
    expect(controller.getSnapshot().rows[0]?.fiberPhase).toBe('quiescing')
    expect(controller.getSnapshot().failedCount).toBe(0)
    controller.dispose()
  })

  // An HMR swap replaces the entry; a cached row would outlive the module.
  it('rebuilds rows on invalidation instead of merging stale ones', () => {
    const inventory = new FakeInventory()
    const signal = changeSignal()
    inventory.list.mockReturnValue({ entries: [entry('old'), entry('kept')] })
    const controller = new PluginInventoryController(inventory, signal.onChange)
    expect(controller.getSnapshot().rows.map(row => row.entryId)).toEqual(['old', 'kept'])

    inventory.list.mockReturnValue({
      entries: [entry('kept', { fiberPhase: 'loading' }), entry('new')],
    })
    signal.emit()

    expect(controller.getSnapshot().rows.map(row => row.entryId)).toEqual(['kept', 'new'])
    expect(controller.getSnapshot().rows[0]?.fiberPhase).toBe('loading')
    controller.dispose()
  })

  it('keeps selection on its entry id across an HMR swap', () => {
    const inventory = new FakeInventory()
    const signal = changeSignal()
    inventory.list.mockReturnValue({ entries: [entry('a'), entry('b'), entry('c')] })
    const controller = new PluginInventoryController(inventory, signal.onChange)
    controller.move('down')
    expect(controller.selected()?.entryId).toBe('b')

    inventory.list.mockReturnValue({ entries: [entry('new'), entry('a'), entry('b'), entry('c')] })
    signal.emit()
    expect(controller.selected()?.entryId).toBe('b')

    // A disposed entry falls back to the first row rather than a stale index.
    inventory.list.mockReturnValue({ entries: [entry('a')] })
    signal.emit()
    expect(controller.selected()?.entryId).toBe('a')
    controller.dispose()
  })

  it('rejects a malformed snapshot rather than rendering it', () => {
    const reportError = vi.fn()
    const inventory = new FakeInventory()
    inventory.list.mockReturnValue({ entries: 'not-an-array' } as unknown as PluginInventorySnapshot)
    const controller = new PluginInventoryController(inventory, undefined, { reportError })

    expect(controller.getSnapshot()).toMatchObject({ rows: [], status: 'error' })
    expect(controller.getSnapshot().error).toContain('invalid snapshot')
    expect(reportError).toHaveBeenCalled()
    controller.dispose()
  })

  it('bounds the entry list and counts what it dropped', () => {
    const inventory = new FakeInventory()
    inventory.list.mockReturnValue({
      entries: Array.from({ length: 6 }, (_, index) => entry(`e${String(index)}`)),
    })
    const controller = new PluginInventoryController(inventory, undefined, { maxEntries: 4 })

    expect(controller.getSnapshot().rows).toHaveLength(4)
    expect(controller.getSnapshot().droppedEntries).toBe(2)
    controller.dispose()
  })

  it('bounds a long module specifier', () => {
    const inventory = new FakeInventory()
    inventory.list.mockReturnValue({ entries: [entry('x', { moduleName: 'm'.repeat(5_000) })] })
    const controller = new PluginInventoryController(inventory)
    expect(controller.getSnapshot().rows[0]?.moduleName).toHaveLength(300)
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    expect(() => new PluginInventoryController(undefined, undefined, { maxEntries: 0 }))
      .toThrow('maxEntries must be a positive safe integer')
  })

  it('surfaces a read failure and recovers on the next read', () => {
    const inventory = new FakeInventory()
    inventory.list.mockImplementation(() => {
      throw new Error('loader unavailable')
    })
    const controller = new PluginInventoryController(inventory)

    expect(controller.getSnapshot()).toMatchObject({
      error: 'loader unavailable',
      status: 'error',
    })

    inventory.list.mockReturnValue({ entries: [entry('a')] })
    expect(controller.refresh()).toBe(true)
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('unsubscribes on disposal and never updates afterwards', () => {
    const inventory = new FakeInventory()
    const signal = changeSignal()
    inventory.list.mockReturnValue({ entries: [entry('a')] })
    const controller = new PluginInventoryController(inventory, signal.onChange)
    const listener = vi.fn()
    controller.subscribe(listener)
    const revision = controller.getSnapshot().revision

    controller.dispose()

    expect(signal.unsubscribes).toBe(1)
    inventory.list.mockReturnValue({ entries: [entry('b')] })
    signal.emit()
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().revision).toBe(revision)
    expect(() => controller.refresh()).toThrow('PluginInventoryController is disposed')
    controller.dispose()
  })
})
