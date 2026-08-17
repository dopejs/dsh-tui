import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'

import { McpInventoryController, type McpToolSource } from './mcp-inventory-controller'

function tool(name: string, description = `does ${name}`): ToolSchema {
  return { description, name, parameters: {} }
}

class FakeToolRegistry implements McpToolSource {
  readonly schemas = vi.fn<() => ToolSchema[]>(() => [])
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

describe('McpInventoryController (M4.3)', () => {
  it('is unavailable without a tool registry', () => {
    const controller = new McpInventoryController()
    expect(controller.getSnapshot()).toMatchObject({ servers: [], status: 'unavailable' })
    expect(controller.refresh()).toBe(false)
    controller.dispose()
  })

  // The baseline publishes no MCP health registry; a tool list says nothing
  // about the transport, so inferring connection state would be a fiction.
  it('reports connection health as unsupported rather than inferring it', () => {
    const controller = new McpInventoryController(new FakeToolRegistry())
    expect(controller.getSnapshot().health).toBe('unsupported-no-public-registry')
    controller.dispose()
  })

  it('groups server-qualified tools by server and counts the rest', () => {
    const registry = new FakeToolRegistry()
    registry.schemas.mockReturnValue([
      tool('mcp__github__create_issue'),
      tool('mcp__github__list_repos'),
      tool('mcp__figma__get_file'),
      tool('read_file'),
      tool('bash'),
    ])
    const controller = new McpInventoryController(registry)

    const snapshot = controller.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.servers.map(server => [server.name, server.toolCount])).toEqual([
      ['figma', 1],
      ['github', 2],
    ])
    expect(snapshot.servers[1]?.tools.map(row => row.rawName))
      .toEqual(['create_issue', 'list_repos'])
    expect(snapshot.servers[1]?.tools[0]?.qualifiedName).toBe('mcp__github__create_issue')
    expect(snapshot.nonMcpToolCount).toBe(2)
    controller.dispose()
  })

  it('treats a name that does not match the public grammar as a plain tool', () => {
    const registry = new FakeToolRegistry()
    registry.schemas.mockReturnValue([
      tool('mcp__ok__real'),
      tool('mcp__bad'),
      tool('mcp____empty_server'),
      tool(`mcp__${'x'.repeat(33)}__too_long`),
    ])
    const controller = new McpInventoryController(registry)

    expect(controller.getSnapshot().servers.map(server => server.name)).toEqual(['ok'])
    expect(controller.getSnapshot().nonMcpToolCount).toBe(3)
    controller.dispose()
  })

  // A reconnect re-registers the server's tools; the inventory is rebuilt, not
  // patched, so rows from the previous connection cannot survive it.
  it('rebuilds the inventory on a registry change instead of merging', () => {
    const registry = new FakeToolRegistry()
    const signal = changeSignal()
    registry.schemas.mockReturnValue([
      tool('mcp__github__old_tool'),
      tool('mcp__stale__gone'),
    ])
    const controller = new McpInventoryController(registry, signal.onChange)
    expect(controller.getSnapshot().servers.map(server => server.name))
      .toEqual(['github', 'stale'])

    registry.schemas.mockReturnValue([tool('mcp__github__new_tool')])
    signal.emit()

    const snapshot = controller.getSnapshot()
    expect(snapshot.servers.map(server => server.name)).toEqual(['github'])
    expect(snapshot.servers[0]?.tools.map(row => row.rawName)).toEqual(['new_tool'])
    controller.dispose()
  })

  it('keeps selection on its server name across a reconnect', () => {
    const registry = new FakeToolRegistry()
    const signal = changeSignal()
    registry.schemas.mockReturnValue([tool('mcp__a__x'), tool('mcp__b__y'), tool('mcp__c__z')])
    const controller = new McpInventoryController(registry, signal.onChange)
    controller.move('down')
    expect(controller.selected()?.name).toBe('b')

    // A new server sorts ahead of the selection and shifts every index.
    registry.schemas.mockReturnValue([
      tool('mcp__a__x'), tool('mcp__aa__w'), tool('mcp__b__y'), tool('mcp__c__z'),
    ])
    signal.emit()
    expect(controller.selected()?.name).toBe('b')

    // Losing the server falls back to the first row rather than a stale index.
    registry.schemas.mockReturnValue([tool('mcp__a__x')])
    signal.emit()
    expect(controller.selected()?.name).toBe('a')
    controller.dispose()
  })

  // schemas() is the model-facing projection: it carries no transport object,
  // header map, or environment, so there is nothing to redact.
  it('reads only the model-facing projection, never transport configuration', () => {
    const registry = new FakeToolRegistry()
    registry.schemas.mockReturnValue([tool('mcp__github__create_issue')])
    const controller = new McpInventoryController(registry)

    const serialized = JSON.stringify(controller.getSnapshot())
    expect(serialized).not.toContain('headers')
    expect(serialized).not.toContain('env')
    expect(serialized).not.toContain('command')
    expect(Object.keys(registry)).toEqual(['schemas'])
    controller.dispose()
  })

  it('bounds servers and per-server tools and counts what it dropped', () => {
    const registry = new FakeToolRegistry()
    registry.schemas.mockReturnValue([
      ...Array.from({ length: 5 }, (_, index) => tool(`mcp__s${String(index)}__only`)),
      ...Array.from({ length: 4 }, (_, index) => tool(`mcp__s0__extra${String(index)}`)),
    ])
    const controller = new McpInventoryController(registry, undefined, {
      maxServers: 3,
      maxToolsPerServer: 2,
    })

    const snapshot = controller.getSnapshot()
    expect(snapshot.servers).toHaveLength(3)
    expect(snapshot.droppedServers).toBe(2)
    expect(snapshot.servers[0]).toMatchObject({ droppedTools: 3, name: 's0', toolCount: 5 })
    expect(snapshot.servers[0]?.tools).toHaveLength(2)
    controller.dispose()
  })

  it('bounds a hostile description from a remote server', () => {
    const registry = new FakeToolRegistry()
    registry.schemas.mockReturnValue([tool('mcp__evil__x', 'y'.repeat(5_000))])
    const controller = new McpInventoryController(registry)
    expect(controller.getSnapshot().servers[0]?.tools[0]?.description).toHaveLength(300)
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    expect(() => new McpInventoryController(undefined, undefined, { maxServers: 0 }))
      .toThrow('maxServers must be a positive safe integer')
    expect(() => new McpInventoryController(undefined, undefined, { maxToolsPerServer: 0 }))
      .toThrow('maxToolsPerServer must be a positive safe integer')
  })

  it('surfaces a registry failure and recovers on the next read', () => {
    const reportError = vi.fn()
    const registry = new FakeToolRegistry()
    registry.schemas.mockImplementation(() => {
      throw new Error('registry unavailable')
    })
    const controller = new McpInventoryController(registry, undefined, { reportError })

    expect(controller.getSnapshot()).toMatchObject({
      error: 'registry unavailable',
      status: 'error',
    })
    expect(reportError).toHaveBeenCalled()

    registry.schemas.mockReturnValue([tool('mcp__a__x')])
    expect(controller.refresh()).toBe(true)
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('unsubscribes on disposal and never updates afterwards', () => {
    const registry = new FakeToolRegistry()
    const signal = changeSignal()
    registry.schemas.mockReturnValue([tool('mcp__a__x')])
    const controller = new McpInventoryController(registry, signal.onChange)
    const listener = vi.fn()
    controller.subscribe(listener)
    const revision = controller.getSnapshot().revision

    controller.dispose()

    expect(signal.unsubscribes).toBe(1)
    registry.schemas.mockReturnValue([tool('mcp__b__y')])
    signal.emit()
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().revision).toBe(revision)
    expect(() => controller.refresh()).toThrow('McpInventoryController is disposed')
    controller.dispose()
  })
})
