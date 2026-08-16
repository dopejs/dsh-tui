import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

const DEFAULT_MAX_CATALOG_ENTRIES = 1_000
const DEFAULT_MAX_QUERY_CODE_UNITS = 1_000
const DEFAULT_MAX_RESULTS = 100
const MAX_METADATA_CODE_UNITS = 500

type Listener = () => void

export type TuiActionId =
  | 'activity.center'
  | 'changes.center'
  | 'composer.clear'
  | 'jobs.center'
  | 'permission.center'
  | 'projection.center'
  | 'recovery.center'
  | 'session.center'
  | 'skill.center'
  | 'subagent.center'
  | 'transcript.compact-tools'
  | 'transcript.copy-visible'
  | 'transcript.search'
  | 'transcript.to-end'
  | 'transcript.to-start'
  | 'tui.exit'

export interface TuiActionDescriptor {
  readonly description: string
  readonly id: TuiActionId
  readonly keywords?: readonly string[]
  readonly title: string
}

export type PaletteItem = {
  readonly description: string
  readonly id: string
  readonly inputHint?: string
  readonly kind: 'command'
  readonly label: string
  readonly name: string
} | {
  readonly action: TuiActionId
  readonly description: string
  readonly id: string
  readonly kind: 'action'
  readonly label: string
}

export interface CommandCatalog {
  list(): readonly CommandDescriptor[]
  subscribe(listener: Listener): () => void
}

export interface CommandPaletteOptions {
  readonly actions?: readonly TuiActionDescriptor[]
  readonly maxCatalogEntries?: number
  readonly maxQueryCodeUnits?: number
  readonly maxResults?: number
}

export interface CommandPaletteSnapshot {
  readonly catalogTruncated: boolean
  readonly error?: string
  readonly items: readonly PaletteItem[]
  readonly query: string
  readonly revision: number
  readonly selectedIndex?: number
  readonly totalMatches: number
}

export const DEFAULT_TUI_ACTIONS: readonly TuiActionDescriptor[] = Object.freeze([
  Object.freeze({
    description: 'Review plan, job, and subagent activity in one bounded list',
    id: 'activity.center',
    keywords: Object.freeze(['alerts', 'activity', 'notifications', 'updates']),
    title: 'Open activity',
  }),
  Object.freeze({
    description: 'Review durable tool-presented file changes',
    id: 'changes.center',
    keywords: Object.freeze(['diff', 'files', 'review']),
    title: 'Open changes',
  }),
  Object.freeze({
    description: 'Clear the current composer draft',
    id: 'composer.clear',
    keywords: Object.freeze(['draft', 'input']),
    title: 'Clear composer',
  }),
  Object.freeze({
    description: 'Inspect and cancel background jobs owned by this session',
    id: 'jobs.center',
    keywords: Object.freeze(['background', 'cancel', 'jobs', 'kill', 'tasks']),
    title: 'Open jobs',
  }),
  Object.freeze({
    description: 'Inspect and change the exact session permission preset',
    id: 'permission.center',
    keywords: Object.freeze(['approval', 'sandbox', 'safety']),
    title: 'Open permissions',
  }),
  Object.freeze({
    description: 'Inspect plan, todo, goal, usage, and bounded projection diagnostics',
    id: 'projection.center',
    keywords: Object.freeze(['activity', 'context', 'goal', 'plan', 'todo', 'usage']),
    title: 'Open projections',
  }),
  Object.freeze({
    description: 'Flush, export, fork, and inspect recovery boundaries',
    id: 'recovery.center',
    keywords: Object.freeze(['checkpoint', 'durability', 'rewind']),
    title: 'Open recovery',
  }),
  Object.freeze({
    description: 'Browse and resume persisted sessions',
    id: 'session.center',
    keywords: Object.freeze(['open', 'resume', 'switch']),
    title: 'Open session center',
  }),
  Object.freeze({
    description: 'Browse discovered skills and insert an invocation',
    id: 'skill.center',
    keywords: Object.freeze(['catalog', 'extensions', 'skills']),
    title: 'Open skills',
  }),
  Object.freeze({
    description: 'Inspect the subagent tree, follow up, interrupt, and attach',
    id: 'subagent.center',
    keywords: Object.freeze(['agents', 'children', 'delegation', 'subagent', 'tree']),
    title: 'Open subagents',
  }),
  Object.freeze({
    description: 'Fold or expand all retained tool result cards',
    id: 'transcript.compact-tools',
    keywords: Object.freeze(['fold', 'expand', 'tool']),
    title: 'Toggle compact tool cards',
  }),
  Object.freeze({
    description: 'Request terminal clipboard copy for the visible transcript',
    id: 'transcript.copy-visible',
    keywords: Object.freeze(['clipboard', 'osc52']),
    title: 'Copy visible transcript',
  }),
  Object.freeze({
    description: 'Search the retained transcript window',
    id: 'transcript.search',
    keywords: Object.freeze(['find', 'history']),
    title: 'Search transcript',
  }),
  Object.freeze({
    description: 'Return to the live transcript tail',
    id: 'transcript.to-end',
    keywords: Object.freeze(['bottom', 'latest', 'tail']),
    title: 'Go to transcript end',
  }),
  Object.freeze({
    description: 'Jump to the oldest retained transcript row',
    id: 'transcript.to-start',
    keywords: Object.freeze(['oldest', 'top']),
    title: 'Go to transcript start',
  }),
  Object.freeze({
    description: 'Gracefully close the interactive TUI',
    id: 'tui.exit',
    keywords: Object.freeze(['quit', 'close']),
    title: 'Exit TUI',
  }),
])

interface SearchableItem {
  readonly item: PaletteItem
  readonly searchText: string
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function bounded(value: string): string {
  return value.length <= MAX_METADATA_CODE_UNITS
    ? value
    : `${value.slice(0, MAX_METADATA_CODE_UNITS - 1)}…`
}

function renderError(error: unknown): string {
  try {
    return bounded(error instanceof Error ? error.message : String(error))
  } catch {
    return '<unrenderable command catalog failure>'
  }
}

function subsequenceScore(text: string, query: string): number | undefined {
  if (query === '') return 0
  const exact = text.indexOf(query)
  if (exact !== -1) return exact * 2 + (text.startsWith(query) ? 0 : 20)
  let queryIndex = 0
  let first = -1
  let last = -1
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] !== query[queryIndex]) continue
    if (first === -1) first = index
    last = index
    queryIndex += 1
  }
  if (queryIndex !== query.length) return undefined
  return 100 + first + (last - first - query.length + 1) * 3
}

function fuzzyScore(text: string, query: string): number | undefined {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  let score = 0
  for (const token of tokens) {
    const tokenScore = subsequenceScore(text, token)
    if (tokenScore === undefined) return undefined
    score += tokenScore
  }
  return score
}

export class CommandPaletteController {
  readonly #actions: readonly TuiActionDescriptor[]
  readonly #catalog: CommandCatalog
  readonly #listeners = new Set<Listener>()
  readonly #maxCatalogEntries: number
  readonly #maxQueryCodeUnits: number
  readonly #maxResults: number
  readonly #stop: () => void
  #catalogTruncated = false
  #disposed = false
  #error: string | undefined
  #query = ''
  #revision = 0
  #searchable: readonly SearchableItem[] = Object.freeze([])
  #selectedIndex = 0
  #snapshot: CommandPaletteSnapshot

  constructor(catalog: CommandCatalog, options: CommandPaletteOptions = {}) {
    this.#catalog = catalog
    this.#actions = options.actions ?? DEFAULT_TUI_ACTIONS
    this.#maxCatalogEntries = positiveLimit(
      options.maxCatalogEntries,
      DEFAULT_MAX_CATALOG_ENTRIES,
      'maxCatalogEntries',
    )
    this.#maxQueryCodeUnits = positiveLimit(
      options.maxQueryCodeUnits,
      DEFAULT_MAX_QUERY_CODE_UNITS,
      'maxQueryCodeUnits',
    )
    this.#maxResults = positiveLimit(options.maxResults, DEFAULT_MAX_RESULTS, 'maxResults')
    this.#refreshCatalog()
    this.#snapshot = this.#createSnapshot()
    this.#stop = catalog.subscribe(this.refresh)
  }

  getSnapshot = (): CommandPaletteSnapshot => this.#snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.#assertActive()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  reset(): void {
    this.#assertActive()
    this.#query = ''
    this.#selectedIndex = 0
    this.#refreshCatalog()
    this.#publish()
  }

  refresh = (): void => {
    if (this.#disposed) return
    const selectedId = this.selected()?.id
    this.#refreshCatalog()
    const items = this.#matchingItems()
    const retained = selectedId === undefined ? -1 : items.findIndex(item => item.id === selectedId)
    this.#selectedIndex = retained === -1
      ? Math.min(this.#selectedIndex, Math.max(0, items.length - 1))
      : retained
    this.#publish(items)
  }

  insertQuery(value: string): 'applied' | 'limit-exceeded' | 'unchanged' {
    this.#assertActive()
    if (value === '') return 'unchanged'
    if (this.#query.length + value.length > this.#maxQueryCodeUnits) return 'limit-exceeded'
    this.#query += value
    this.#selectedIndex = 0
    this.#publish()
    return 'applied'
  }

  backspaceQuery(): boolean {
    this.#assertActive()
    if (this.#query === '') return false
    const characters = Array.from(this.#query)
    characters.pop()
    this.#query = characters.join('')
    this.#selectedIndex = 0
    this.#publish()
    return true
  }

  move(direction: 'down' | 'up'): boolean {
    this.#assertActive()
    const count = this.#snapshot.items.length
    if (count < 2) return false
    this.#selectedIndex = direction === 'down'
      ? (this.#selectedIndex + 1) % count
      : (this.#selectedIndex - 1 + count) % count
    this.#publish(this.#snapshot.items)
    return true
  }

  selected(): PaletteItem | undefined {
    return this.#snapshot.items[this.#selectedIndex]
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    try {
      this.#stop()
    } finally {
      this.#listeners.clear()
      this.#searchable = Object.freeze([])
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('CommandPaletteController is disposed')
  }

  #createSnapshot(items = this.#matchingItems()): CommandPaletteSnapshot {
    return Object.freeze({
      catalogTruncated: this.#catalogTruncated,
      ...(this.#error === undefined ? {} : { error: this.#error }),
      items: Object.freeze(items),
      query: this.#query,
      revision: this.#revision,
      ...(items.length === 0 ? {} : { selectedIndex: this.#selectedIndex }),
      totalMatches: this.#matchingItems(false).length,
    })
  }

  #matchingItems(limit = true): PaletteItem[] {
    const matches = this.#searchable
      .map((candidate) => {
        const score = fuzzyScore(candidate.searchText, this.#query)
        return score === undefined ? undefined : { ...candidate, score }
      })
      .filter((candidate): candidate is SearchableItem & { readonly score: number } => (
        candidate !== undefined
      ))
      .sort((left, right) => left.score - right.score
        || left.item.label.localeCompare(right.item.label, 'en'))
      .map(candidate => candidate.item)
    return limit ? matches.slice(0, this.#maxResults) : matches
  }

  #publish(items?: readonly PaletteItem[]): void {
    this.#revision += 1
    this.#snapshot = this.#createSnapshot(items === undefined ? undefined : [...items])
    for (const listener of this.#listeners) listener()
  }

  #refreshCatalog(): void {
    let commands: readonly CommandDescriptor[] = []
    this.#error = undefined
    try {
      commands = this.#catalog.list()
    } catch (error) {
      this.#error = renderError(error)
    }
    this.#catalogTruncated = commands.length > this.#maxCatalogEntries
    const commandItems: SearchableItem[] = commands
      .slice(0, this.#maxCatalogEntries)
      .map((command) => {
        const label = `/${bounded(command.name)}`
        const description = bounded(command.description)
        const inputHint = command.input === undefined ? undefined : bounded(command.input.hint)
        const item: PaletteItem = Object.freeze({
          description,
          id: `command:${command.name}`,
          ...(inputHint === undefined ? {} : { inputHint }),
          kind: 'command',
          label,
          name: command.name,
        })
        return Object.freeze({
          item,
          searchText: `${label} ${description} ${inputHint ?? ''}`.toLowerCase(),
        })
      })
    const actionItems: SearchableItem[] = this.#actions.map((action) => {
      const item: PaletteItem = Object.freeze({
        action: action.id,
        description: bounded(action.description),
        id: `action:${action.id}`,
        kind: 'action',
        label: bounded(action.title),
      })
      return Object.freeze({
        item,
        searchText: [action.title, action.description, action.id, ...(action.keywords ?? [])]
          .join(' ')
          .toLowerCase(),
      })
    })
    this.#searchable = Object.freeze([...commandItems, ...actionItems])
  }
}
