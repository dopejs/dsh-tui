import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const DEFAULT_MAX_SERVERS = 100
const DEFAULT_MAX_TOOLS_PER_SERVER = 200
const MAX_TEXT_CODE_UNITS = 300

type Listener = () => void

/**
 * The documented public grammar for an MCP-bridged tool name:
 * `mcp__<serverName>__<rawName>`, where `serverName` matches
 * `[A-Za-z0-9_-]{1,32}`. Grouping by it reads only the registry's public
 * surface — no plugin configuration is consulted.
 */
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/

/**
 * Why connection health is reported rather than shown.
 *
 * `@deepseek-ai/dsh-mcp-client` registers tools on `ctx.tools` and owns its
 * connection privately; the baseline publishes no health or status registry.
 * The visible facts are therefore presence and tool count, which the registry
 * really does answer. Anything finer — configured, connecting, degraded —
 * would be inferred from a tool list that says nothing about the transport.
 */
export type McpHealthState = 'unsupported-no-public-registry'

export interface McpToolRow {
  readonly description: string
  /** The tool name as the model sees it. */
  readonly qualifiedName: string
  /** The server-local name, with the `mcp__<server>__` prefix removed. */
  readonly rawName: string
}

export interface McpServerRow {
  readonly droppedTools: number
  readonly name: string
  readonly toolCount: number
  readonly tools: readonly McpToolRow[]
}

export interface McpInventorySnapshot {
  readonly droppedServers: number
  readonly error?: string
  /** Always unavailable on this baseline; see {@link McpHealthState}. */
  readonly health: McpHealthState
  /** Tools present that are not MCP-bridged; shown as a total, not listed. */
  readonly nonMcpToolCount: number
  readonly revision: number
  readonly selectedIndex?: number
  readonly servers: readonly McpServerRow[]
  readonly status: 'error' | 'ready' | 'unavailable'
}

export interface McpInventoryOptions {
  readonly maxServers?: number
  readonly maxToolsPerServer?: number
  readonly reportError?: (error: unknown) => void
}

/**
 * The registry seams this controller consumes. `schemas()` returns the
 * model-facing projection only — it excludes execution and presentation
 * callbacks — so no transport object or credential is reachable from here.
 */
export interface McpToolSource {
  schemas(): readonly ToolSchema[]
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function boundedText(value: string, maximum = MAX_TEXT_CODE_UNITS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function errorMessage(error: unknown): string {
  try {
    return boundedText(error instanceof Error ? error.message : String(error), 500)
  } catch {
    return '<unrenderable tool registry failure>'
  }
}

export class McpInventoryController {
  readonly #listeners = new Set<Listener>()
  readonly #maxServers: number
  readonly #maxToolsPerServer: number
  readonly #reportError: (error: unknown) => void
  readonly #source: McpToolSource | undefined
  #disposed = false
  #droppedServers = 0
  #error: string | undefined
  #generation = 0
  #nonMcpToolCount = 0
  #revision = 0
  #selectedName: string | undefined
  #servers: readonly McpServerRow[] = Object.freeze([])
  #snapshot: McpInventorySnapshot
  #stop: (() => void) | undefined

  constructor(
    source?: McpToolSource,
    /**
     * Invalidation signal, wired to the registry's `tools/change` event. A
     * reconnect re-registers the server's tools, so this is what makes a stale
     * inventory visible.
     */
    onChange?: (listener: Listener) => () => void,
    options: McpInventoryOptions = {},
  ) {
    this.#source = source
    this.#maxServers = positiveLimit(options.maxServers, DEFAULT_MAX_SERVERS, 'maxServers')
    this.#maxToolsPerServer = positiveLimit(
      options.maxToolsPerServer,
      DEFAULT_MAX_TOOLS_PER_SERVER,
      'maxToolsPerServer',
    )
    this.#reportError = options.reportError ?? (() => undefined)
    this.#snapshot = this.#createSnapshot()
    if (source === undefined) return
    if (onChange !== undefined) {
      try {
        this.#stop = onChange(() => {
          if (!this.#disposed) this.refresh()
        })
      } catch (error) {
        this.#reportError(error)
      }
    }
    this.refresh()
  }

  getSnapshot = (): McpInventorySnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Re-read the registry. The whole inventory is rebuilt from the current
   * generation rather than patched, so a reconnect that replaces a server's
   * tools cannot leave rows from the previous connection behind.
   */
  refresh(): boolean {
    this.#assertActive()
    const source = this.#source
    if (source === undefined) return false
    const generation = ++this.#generation
    let schemas: readonly ToolSchema[]
    try {
      schemas = source.schemas()
    } catch (error) {
      this.#recordError(error)
      return false
    }
    if (generation !== this.#generation) return false
    if (!Array.isArray(schemas)) {
      this.#recordError(new Error('Tool registry returned a non-array projection'))
      return false
    }
    this.#ingest(schemas)
    this.#error = undefined
    this.#publish()
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    if (this.#servers.length < 2) return false
    const current = this.#selectedIndex()
    const next = direction === 'down'
      ? (current + 1) % this.#servers.length
      : (current - 1 + this.#servers.length) % this.#servers.length
    this.#selectedName = this.#servers[next]?.name
    this.#publish()
    return true
  }

  selected(): McpServerRow | undefined {
    this.#assertActive()
    return this.#servers[this.#selectedIndex()]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    const stop = this.#stop
    this.#stop = undefined
    try {
      stop?.()
    } catch (error) {
      this.#reportError(error)
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('McpInventoryController is disposed')
  }

  #ingest(schemas: readonly ToolSchema[]): void {
    const grouped = new Map<string, McpToolRow[]>()
    const dropped = new Map<string, number>()
    let nonMcp = 0
    for (const schema of schemas) {
      const match = MCP_TOOL_NAME.exec(schema.name)
      if (match === null) {
        nonMcp += 1
        continue
      }
      const [, server, rawName] = match
      if (server === undefined || rawName === undefined) {
        nonMcp += 1
        continue
      }
      const tools = grouped.get(server) ?? []
      if (tools.length >= this.#maxToolsPerServer) {
        dropped.set(server, (dropped.get(server) ?? 0) + 1)
        continue
      }
      tools.push(Object.freeze({
        description: boundedText(schema.description),
        qualifiedName: boundedText(schema.name),
        rawName: boundedText(rawName),
      }))
      grouped.set(server, tools)
    }
    const names = [...grouped.keys()].sort()
    this.#droppedServers = Math.max(0, names.length - this.#maxServers)
    this.#nonMcpToolCount = nonMcp
    this.#servers = Object.freeze(names.slice(0, this.#maxServers).map((name) => {
      const tools = grouped.get(name) ?? []
      return Object.freeze({
        droppedTools: dropped.get(name) ?? 0,
        name,
        toolCount: tools.length + (dropped.get(name) ?? 0),
        tools: Object.freeze([...tools].sort((a, b) => a.rawName.localeCompare(b.rawName))),
      })
    }))
    this.#reconcileSelection()
  }

  /** Selection follows a server name, so a reconnect cannot retarget it. */
  #reconcileSelection(): void {
    if (this.#servers.length === 0) {
      this.#selectedName = undefined
      return
    }
    const name = this.#selectedName
    if (name === undefined || !this.#servers.some(server => server.name === name)) {
      this.#selectedName = this.#servers[0]?.name
    }
  }

  #selectedIndex(): number {
    const name = this.#selectedName
    if (name === undefined) return 0
    const index = this.#servers.findIndex(server => server.name === name)
    return index < 0 ? 0 : index
  }

  #recordError(error: unknown): void {
    this.#error = errorMessage(error)
    this.#reportError(error)
    this.#publish()
  }

  #publish(): void {
    if (this.#disposed) return
    this.#revision += 1
    this.#snapshot = this.#createSnapshot()
    for (const listener of [...this.#listeners]) listener()
  }

  #createSnapshot(): McpInventorySnapshot {
    const status: McpInventorySnapshot['status'] = this.#source === undefined
      ? 'unavailable'
      : this.#error !== undefined ? 'error' : 'ready'
    return Object.freeze({
      droppedServers: this.#droppedServers,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      health: 'unsupported-no-public-registry',
      nonMcpToolCount: this.#nonMcpToolCount,
      revision: this.#revision,
      ...(this.#servers.length === 0 ? {} : { selectedIndex: this.#selectedIndex() }),
      servers: this.#servers,
      status,
    })
  }
}
