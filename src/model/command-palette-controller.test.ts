import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'

import {
  CommandPaletteController,
  type CommandCatalog,
  type TuiActionDescriptor,
} from './command-palette-controller'

class FixtureCatalog implements CommandCatalog {
  readonly #listeners = new Set<() => void>()
  commands: readonly CommandDescriptor[]
  failure: unknown

  constructor(commands: readonly CommandDescriptor[]) {
    this.commands = commands
  }

  list = (): readonly CommandDescriptor[] => {
    if (this.failure !== undefined) throw this.failure
    return this.commands
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  change(commands: readonly CommandDescriptor[]): void {
    this.commands = commands
    for (const listener of this.#listeners) listener()
  }

  get listenerCount(): number {
    return this.#listeners.size
  }
}

const actions: readonly TuiActionDescriptor[] = [{
  description: 'Search retained transcript rows',
  id: 'transcript.search',
  keywords: ['find', 'history'],
  title: 'Search transcript',
}]

describe('CommandPaletteController (M1.3)', () => {
  it('fuzzy-filters Harness descriptors and local actions deterministically', () => {
    const catalog = new FixtureCatalog([
      { description: 'Resume a durable session', name: 'resume' },
      { description: 'Review current changes', input: { hint: '<path>' }, name: 'review' },
    ])
    const palette = new CommandPaletteController(catalog, { actions })

    expect(palette.getSnapshot().items.map(item => item.label)).toEqual([
      '/resume',
      '/review',
      'Search transcript',
    ])
    expect(palette.insertQuery('rvw')).toBe('applied')
    expect(palette.getSnapshot().items).toEqual([expect.objectContaining({
      inputHint: '<path>',
      kind: 'command',
      name: 'review',
    })])

    palette.reset()
    expect(palette.insertQuery('history')).toBe('applied')
    expect(palette.selected()).toMatchObject({
      action: 'transcript.search',
      kind: 'action',
    })
    palette.dispose()
  })

  it('supports bounded query editing and wrapped selection', () => {
    const catalog = new FixtureCatalog([
      { description: 'Alpha', name: 'alpha' },
      { description: 'Beta', name: 'beta' },
    ])
    const palette = new CommandPaletteController(catalog, {
      actions: [],
      maxQueryCodeUnits: 2,
    })

    expect(palette.move('up')).toBe(true)
    expect(palette.selected()?.id).toBe('command:beta')
    expect(palette.move('down')).toBe(true)
    expect(palette.insertQuery('al')).toBe('applied')
    expect(palette.insertQuery('p')).toBe('limit-exceeded')
    expect(palette.backspaceQuery()).toBe(true)
    expect(palette.getSnapshot().query).toBe('a')

    palette.dispose()
  })

  it('refreshes live catalog changes, preserves selection, and unregisters', () => {
    const catalog = new FixtureCatalog([
      { description: 'Alpha', name: 'alpha' },
      { description: 'Beta', name: 'beta' },
    ])
    const palette = new CommandPaletteController(catalog, { actions: [] })
    const listener = vi.fn()
    palette.subscribe(listener)
    palette.move('down')

    catalog.change([
      { description: 'Beta changed', name: 'beta' },
      { description: 'Gamma', name: 'gamma' },
    ])
    expect(palette.selected()?.id).toBe('command:beta')
    expect(palette.selected()?.description).toBe('Beta changed')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(catalog.listenerCount).toBe(1)

    palette.dispose()
    expect(catalog.listenerCount).toBe(0)
    catalog.change([])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('bounds catalog/results and contains discovery failures', () => {
    const catalog = new FixtureCatalog(Array.from({ length: 5 }, (_, index) => ({
      description: `Command ${String(index)}`,
      name: `command-${String(index)}`,
    })))
    const palette = new CommandPaletteController(catalog, {
      actions: [],
      maxCatalogEntries: 3,
      maxResults: 2,
    })

    expect(palette.getSnapshot()).toMatchObject({
      catalogTruncated: true,
      totalMatches: 3,
    })
    expect(palette.getSnapshot().items).toHaveLength(2)
    catalog.failure = new Error('catalog unavailable')
    palette.refresh()
    expect(palette.getSnapshot()).toMatchObject({
      catalogTruncated: false,
      error: 'catalog unavailable',
      items: [],
    })

    palette.dispose()
  })

  it('validates all memory limits', () => {
    const catalog = new FixtureCatalog([])
    expect(() => new CommandPaletteController(catalog, { maxCatalogEntries: 0 })).toThrow('maxCatalogEntries')
    expect(() => new CommandPaletteController(catalog, { maxQueryCodeUnits: 0 })).toThrow('maxQueryCodeUnits')
    expect(() => new CommandPaletteController(catalog, { maxResults: 0 })).toThrow('maxResults')
  })
})
