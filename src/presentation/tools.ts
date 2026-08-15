import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ContentBlock,
} from '@deepseek-ai/dsh-llm'
import type {
  ToolCallView,
  ToolResultView,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'

import { reduceTranscriptBatch, type TranscriptState } from '../model/transcript-reducer'
import type { ToolCardModel, TranscriptRow } from '../model/view-model'

const DEFAULT_MAX_CALLS = 2_000
const DEFAULT_MAX_LINES = 200
const DEFAULT_MAX_LINE_CHARS = 1_000

type ToolResolver = Pick<ToolRuntime, 'get'>

interface CallPresentation {
  readonly args: unknown
  readonly call?: ToolCallView
  readonly name: string
}

export interface ToolTranscriptProjectorOptions {
  readonly agent: Agent
  readonly maxCalls?: number
  readonly maxLineChars?: number
  readonly maxLines?: number
  readonly reportError?: (error: unknown) => void
  readonly tools: ToolResolver
}

function validatedLimit(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100_000) {
    throw new RangeError(`${name} must be a safe integer between 1 and 100000`)
  }
  return resolved
}

function contentLines(content: readonly ContentBlock[] | undefined): string[] {
  if (content === undefined) return []
  return content.flatMap((block): string[] => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return block.text.split('\n')
      case 'image':
        return ['[image]']
      case 'tool-call':
        return [`[tool call: ${block.name}]`]
      case 'tool-result':
        return contentLines(block.content)
      default:
        return ['[unsupported content]']
    }
  })
}

function jsonLines(value: unknown): string[] {
  try {
    return (JSON.stringify(value, undefined, 2) ?? '').split('\n').filter(Boolean)
  } catch {
    return ['[unrenderable input]']
  }
}

function viewTitle(name: string, call: ToolCallView | undefined, result: ToolResultView | undefined) {
  return result?.title ?? call?.title ?? name
}

function cardLines(
  name: string,
  call: ToolCallView | undefined,
  result: ToolResultView | undefined,
  rawContent: readonly ContentBlock[] = [],
): { card: ToolCardModel['card']; lines: string[]; title: string } {
  const title = viewTitle(name, call, result)
  if (result?.card === 'terminal' || call?.card === 'terminal') {
    const terminalCall = call?.card === 'terminal' ? call : undefined
    const terminalResult = result?.card === 'terminal' ? result : undefined
    return {
      card: 'terminal',
      lines: [
        ...(terminalCall?.description === undefined ? [] : [terminalCall.description]),
        ...(terminalCall?.cwd === undefined ? [] : [`cwd: ${terminalCall.cwd}`]),
        `$ ${terminalCall?.title ?? title}`,
        ...(terminalResult?.output === undefined ? [] : terminalResult.output.split('\n')),
        ...(terminalResult?.exitCode === undefined ? [] : [`exit: ${String(terminalResult.exitCode)}`]),
        ...(terminalResult?.signal === undefined ? [] : [`signal: ${terminalResult.signal}`]),
      ],
      title,
    }
  }
  if (result?.card === 'diff' || call?.card === 'diff') {
    const diffs = result?.card === 'diff'
      ? result.diffs
      : call?.card === 'diff' ? call.diffs : []
    return {
      card: 'diff',
      lines: diffs.flatMap(diff => [
        `--- ${diff.path}`,
        ...((diff.oldText ?? '').split('\n').filter(Boolean).map(line => `- ${line}`)),
        ...(diff.newText.split('\n').filter(Boolean).map(line => `+ ${line}`)),
      ]),
      title,
    }
  }
  if (result?.card === 'search') {
    const lines = result.shape === 'paths'
      ? result.paths
      : result.files.flatMap(file => [
          file.path,
          ...file.matches.map(match => `${String(match.lineNumber)}: ${match.line}`),
        ])
    return {
      card: 'search',
      lines: [...lines, `${String(result.total)} total${result.truncated ? ' (truncated)' : ''}`],
      title,
    }
  }
  if (result?.card === 'read') {
    return {
      card: 'read',
      lines: [
        `${result.path} · ${String(result.lines.length)} of ${String(result.totalLines)} lines`,
        ...result.lines.map(line => `${String(line.number).padStart(4)} │ ${line.text}`),
      ],
      title,
    }
  }
  if (result?.card === 'web') {
    const lines = result.kind === 'search'
      ? [
          ...(result.answer === undefined ? [] : [result.answer]),
          ...result.sources.map(source => `${source.title ?? source.url} · ${source.url}`),
          ...(result.truncated ? ['[sources truncated]'] : []),
        ]
      : [
          `${String(result.statusCode)} ${result.url}`,
          ...contentLines(rawContent),
          ...(result.truncated ? ['[content truncated]'] : []),
        ]
    return { card: 'web', lines, title }
  }
  const genericCall = call?.card === 'generic' ? call : undefined
  const genericResult = result?.card === 'generic' ? result : undefined
  return {
    card: 'generic',
    lines: [
      ...(genericCall?.rawInput === undefined ? [] : jsonLines(genericCall.rawInput)),
      ...contentLines(genericCall?.content),
      ...contentLines(genericResult?.content ?? rawContent),
    ],
    title,
  }
}

function boundCard(
  model: ReturnType<typeof cardLines>,
  maxLines: number,
  maxLineChars: number,
): ToolCardModel {
  let truncated = model.lines.length > maxLines
  const lines = model.lines.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineChars) return line
    truncated = true
    return `${line.slice(0, Math.max(0, maxLineChars - 1))}…`
  })
  return Object.freeze({
    card: model.card,
    lines: Object.freeze(lines),
    title: model.title.length <= maxLineChars
      ? model.title
      : `${model.title.slice(0, Math.max(0, maxLineChars - 1))}…`,
    ...(truncated ? { truncated: true as const } : {}),
  })
}

function attachCard(
  state: TranscriptState,
  rowId: string,
  card: ToolCardModel | undefined,
): TranscriptState {
  if (card === undefined) return state
  const index = state.rows.findIndex(row => row.id === rowId)
  if (index < 0) return state
  const rows = [...state.rows]
  rows[index] = Object.freeze({ ...rows[index] as TranscriptRow, toolCard: card })
  return Object.freeze({ ...state, rows: Object.freeze(rows) })
}

export class ToolTranscriptProjector {
  readonly #agent: Agent
  readonly #calls = new Map<string, CallPresentation>()
  readonly #maxCalls: number
  readonly #maxLineChars: number
  readonly #maxLines: number
  readonly #reportError: (error: unknown) => void
  readonly #tools: ToolResolver

  constructor(options: ToolTranscriptProjectorOptions) {
    this.#agent = options.agent
    this.#tools = options.tools
    this.#maxCalls = validatedLimit('maxCalls', options.maxCalls, DEFAULT_MAX_CALLS)
    this.#maxLines = validatedLimit('maxLines', options.maxLines, DEFAULT_MAX_LINES)
    this.#maxLineChars = validatedLimit(
      'maxLineChars', options.maxLineChars, DEFAULT_MAX_LINE_CHARS,
    )
    this.#reportError = options.reportError ?? (() => undefined)
  }

  readonly reduceBatch = (
    state: TranscriptState,
    events: readonly SessionEvent[],
  ): TranscriptState => {
    let next = reduceTranscriptBatch(state, events)
    if (next === state) return state
    const calls = new Map(this.#calls)
    for (const event of events) {
      if (event.seq < state.nextSeq) continue
      try {
        if (event.type === 'tool/call') {
          const args = JSON.parse(event.data.arguments) as unknown
          const definition = this.#tools.get(event.data.name, this.#agent)
          const call = definition?.presentCall?.(args)
          const callId = String(event.data.callId)
          calls.set(callId, { args, ...(call === undefined ? {} : { call }), name: event.data.name })
          next = attachCard(next, `tool:${callId}`, call === undefined
            ? undefined
            : boundCard(cardLines(event.data.name, call, undefined), this.#maxLines, this.#maxLineChars))
        } else if (event.type === 'tool/result') {
          const callId = String(event.data.message.source.callId)
          const pending = calls.get(callId)
          if (pending !== undefined) {
            const definition = this.#tools.get(pending.name, this.#agent)
            const block = event.data.message.content[0]
            const result = definition?.presentResult?.(pending.args, {
              content: block.content,
              isError: block.isError === true,
              ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
            })
            const fallbackCall: ToolCallView | undefined = result === undefined
              ? {
                  card: 'generic',
                  title: pending.call?.title ?? pending.name,
                }
              : pending.call
            const card = result === undefined && pending.call === undefined
              ? undefined
              : boundCard(
                  cardLines(pending.name, fallbackCall, result, block.content),
                  this.#maxLines,
                  this.#maxLineChars,
                )
            next = attachCard(next, `tool:${callId}`, card)
            calls.delete(callId)
          }
        } else if (event.type === 'tool/code-dispatch-start') {
          const callId = String(event.data.subCallId)
          const definition = this.#tools.get(event.data.name, this.#agent)
          const call = definition?.presentCall?.(event.data.arguments)
          calls.set(callId, {
            args: event.data.arguments,
            ...(call === undefined ? {} : { call }),
            name: event.data.name,
          })
          next = attachCard(next, `tool:${callId}`, call === undefined
            ? undefined
            : boundCard(cardLines(event.data.name, call, undefined), this.#maxLines, this.#maxLineChars))
        } else if (event.type === 'tool/code-dispatch') {
          const callId = String(event.data.subCallId)
          const pending = calls.get(callId)
          if (pending !== undefined) {
            const result = this.#tools.get(pending.name, this.#agent)?.presentResult?.(
              pending.args,
              { content: event.data.content, isError: event.data.isError },
            )
            const fallbackCall: ToolCallView | undefined = result === undefined
              ? { card: 'generic', title: pending.call?.title ?? pending.name }
              : pending.call
            const card = result === undefined && pending.call === undefined
              ? undefined
              : boundCard(
                  cardLines(pending.name, fallbackCall, result, event.data.content),
                  this.#maxLines,
                  this.#maxLineChars,
                )
            next = attachCard(next, `tool:${callId}`, card)
            calls.delete(callId)
          }
        }
      } catch (error) {
        try {
          this.#reportError(error)
        } catch {
          // Presentation and diagnostics are both non-authoritative fallbacks.
        }
      }
    }
    while (calls.size > this.#maxCalls) {
      const oldest = calls.keys().next().value as string | undefined
      if (oldest === undefined) break
      calls.delete(oldest)
    }
    this.#calls.clear()
    for (const [id, call] of calls) this.#calls.set(id, call)
    return next
  }
}
