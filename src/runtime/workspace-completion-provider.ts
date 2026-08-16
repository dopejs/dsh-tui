import { opendir, realpath } from 'node:fs/promises'
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

import type {
  CompletionOption,
  CompletionProvider,
  CompletionRequest,
} from '../model/completion-controller'

const DEFAULT_MAX_DIRECTORY_ENTRIES = 2_000
const DEFAULT_MAX_RESULTS = 200
const MAX_QUERY_CODE_UNITS = 100_000

export interface WorkspaceCompletionProviderOptions {
  readonly listCommands: () => readonly CommandDescriptor[]
  readonly maxDirectoryEntries?: number
  readonly maxResults?: number
  readonly workspace: string
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('Completion request aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return error
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function matchScore(candidate: string, rawQuery: string): number | undefined {
  const text = candidate.toLowerCase()
  const query = rawQuery.toLowerCase()
  if (query === '') return 0
  if (text.startsWith(query)) return 0
  const contained = text.indexOf(query)
  if (contained !== -1) return 20 + contained
  let queryIndex = 0
  let gaps = 0
  let last = -1
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] !== query[queryIndex]) continue
    if (last !== -1) gaps += index - last - 1
    last = index
    queryIndex += 1
  }
  return queryIndex === query.length ? 100 + gaps : undefined
}

function pathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  )
}

function normalizePathQuery(query: string): string | undefined {
  if (
    query.length > MAX_QUERY_CODE_UNITS
    || query.includes('\u0000')
    || isAbsolute(query)
    || /^[A-Za-z]:[\\/]/u.test(query)
  ) {
    return undefined
  }
  return query.replaceAll('\\', '/')
}

export class WorkspaceCompletionProvider implements CompletionProvider {
  readonly #listCommands: () => readonly CommandDescriptor[]
  readonly #maxDirectoryEntries: number
  readonly #maxResults: number
  readonly #workspace: string
  #workspaceReal: Promise<string> | undefined

  constructor(options: WorkspaceCompletionProviderOptions) {
    this.#listCommands = options.listCommands
    this.#maxDirectoryEntries = positiveLimit(
      options.maxDirectoryEntries,
      DEFAULT_MAX_DIRECTORY_ENTRIES,
      'maxDirectoryEntries',
    )
    this.#maxResults = positiveLimit(options.maxResults, DEFAULT_MAX_RESULTS, 'maxResults')
    this.#workspace = resolve(options.workspace)
  }

  async complete(request: CompletionRequest): Promise<readonly CompletionOption[]> {
    assertNotAborted(request.signal)
    return request.kind === 'command'
      ? this.#completeCommands(request)
      : this.#completePaths(request)
  }

  #completeCommands(request: CompletionRequest): readonly CompletionOption[] {
    const matches = this.#listCommands()
      .slice(0, this.#maxDirectoryEntries)
      .map((command) => {
        const score = matchScore(command.name, request.query)
        return score === undefined ? undefined : { command, score }
      })
      .filter((entry): entry is { readonly command: CommandDescriptor; readonly score: number } => (
        entry !== undefined
      ))
      .sort((left, right) => left.score - right.score
        || left.command.name.localeCompare(right.command.name, 'en'))
      .slice(0, this.#maxResults)
      .map(({ command }): CompletionOption => Object.freeze({
        description: command.description,
        id: `command:${command.name}`,
        label: `/${command.name}`,
        replacement: `/${command.name}${command.input === undefined ? '' : ' '}`,
      }))
    assertNotAborted(request.signal)
    return Object.freeze(matches)
  }

  async #completePaths(request: CompletionRequest): Promise<readonly CompletionOption[]> {
    const query = normalizePathQuery(request.query)
    if (query === undefined) return Object.freeze([])
    const slash = query.lastIndexOf('/')
    const directoryPrefix = slash === -1 ? '' : query.slice(0, slash + 1)
    const nameQuery = query.slice(slash + 1)
    this.#workspaceReal ??= realpath(this.#workspace)
    const workspaceReal = await this.#workspaceReal
    assertNotAborted(request.signal)
    let directoryReal: string
    try {
      directoryReal = await realpath(resolve(this.#workspace, directoryPrefix))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return Object.freeze([])
      throw error
    }
    assertNotAborted(request.signal)
    if (!pathInside(workspaceReal, directoryReal)) return Object.freeze([])

    const directory = await opendir(directoryReal)
    const entries: Array<{ readonly directory: boolean; readonly name: string }> = []
    let scanned = 0
    try {
      while (scanned < this.#maxDirectoryEntries) {
        assertNotAborted(request.signal)
        const entry = await directory.read()
        if (entry === null) break
        scanned += 1
        if (nameQuery.startsWith('.') === entry.name.startsWith('.')) {
          entries.push({ directory: entry.isDirectory(), name: entry.name })
        }
      }
    } finally {
      await directory.close()
    }
    assertNotAborted(request.signal)
    const matches = entries
      .map((entry) => {
        const score = matchScore(entry.name, nameQuery)
        return score === undefined ? undefined : { entry, score }
      })
      .filter((entry): entry is {
        readonly entry: { readonly directory: boolean; readonly name: string }
        readonly score: number
      } => entry !== undefined)
      .sort((left, right) => left.score - right.score
        || Number(right.entry.directory) - Number(left.entry.directory)
        || left.entry.name.localeCompare(right.entry.name, 'en'))
      .slice(0, this.#maxResults)
      .map(({ entry }): CompletionOption => {
        const replacement = `${directoryPrefix}${entry.name}${entry.directory ? '/' : ''}`
        return Object.freeze({
          description: entry.directory ? 'directory' : 'file',
          id: `path:${replacement}`,
          label: replacement,
          replacement,
        })
      })
    return Object.freeze(matches)
  }
}
