import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { TranscriptRow, TranscriptRowKind } from './view-model'

const DEFAULT_MAX_ROWS = 2_000
const DEFAULT_MAX_ROW_CHARS = 20_000
const MAX_TRACKED_BLOCK_INDEXES = 128
const TRUNCATION_SUFFIX = '… [truncated]'

type ContentBlock = SessionEvent<'user/message'>['data']['content'][number]
type StreamChunk = SessionEvent<'assistant/chunk'>['data']['chunk']

interface PendingAssistant {
  readonly reasoning: string
  readonly reasoningIndexes: readonly number[]
  readonly reasoningTruncated: boolean
  readonly rowId: string
  readonly step: number
  readonly text: string
  readonly textIndexes: readonly number[]
  readonly textTruncated: boolean
  readonly turn: number
}

interface PendingTool {
  readonly callId: string
  readonly rowId: string
  readonly turn: number
}

export interface TranscriptLimits {
  readonly maxRowChars?: number
  readonly maxRows?: number
}

interface ResolvedTranscriptLimits {
  readonly maxRowChars: number
  readonly maxRows: number
}

export interface TranscriptState {
  readonly droppedRows: number
  readonly limits: ResolvedTranscriptLimits
  readonly nextSeq: number
  readonly pendingAssistants: readonly PendingAssistant[]
  readonly pendingTools: readonly PendingTool[]
  readonly rows: readonly TranscriptRow[]
}

export class UnsupportedSessionEventError extends Error {
  override readonly name = 'UnsupportedSessionEventError'

  constructor(readonly eventType: string, readonly seq: number) {
    super(`Unsupported required session event "${eventType}" at seq ${String(seq)}`)
  }
}

export class SessionEventSequenceError extends Error {
  override readonly name = 'SessionEventSequenceError'

  constructor(readonly expected: number, readonly actual: number) {
    super(
      `Session event sequence gap: expected ${String(expected)}, got ${String(actual)}`,
    )
  }
}

function validateLimit(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${String(maximum)}`)
  }
  return resolved
}

export function createTranscriptState(limits: TranscriptLimits = {}): TranscriptState {
  return Object.freeze({
    droppedRows: 0,
    limits: Object.freeze({
      maxRowChars: validateLimit('maxRowChars', limits.maxRowChars, DEFAULT_MAX_ROW_CHARS, 1_000_000),
      maxRows: validateLimit('maxRows', limits.maxRows, DEFAULT_MAX_ROWS, 100_000),
    }),
    nextSeq: 0,
    pendingAssistants: Object.freeze([]),
    pendingTools: Object.freeze([]),
    rows: Object.freeze([]),
  })
}

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

function boundText(value: string, maximum: number): BoundedText {
  if (value.length <= maximum) return { text: value, truncated: false }
  if (maximum <= TRUNCATION_SUFFIX.length) {
    return { text: TRUNCATION_SUFFIX.slice(0, maximum), truncated: true }
  }
  return {
    text: `${value.slice(0, maximum - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`,
    truncated: true,
  }
}

function appendBounded(
  current: string,
  addition: string,
  maximum: number,
  alreadyTruncated: boolean,
): BoundedText {
  if (addition === '') return { text: current, truncated: alreadyTruncated }
  if (alreadyTruncated) return { text: current, truncated: true }
  return boundText(current + addition, maximum)
}

function row(
  id: string,
  kind: TranscriptRowKind,
  content: string,
  maximum: number,
  status?: TranscriptRow['status'],
  alreadyTruncated = false,
): TranscriptRow {
  const bounded = boundText(content, maximum)
  return Object.freeze({
    content: bounded.text,
    id,
    kind,
    ...(status === undefined ? {} : { status }),
    ...(bounded.truncated || alreadyTruncated ? { truncated: true as const } : {}),
  })
}

function projectContentBlock(block: ContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return block.text === '' ? undefined : `Reasoning: ${block.text}`
    case 'image':
      return '[image]'
    case 'tool-call':
      return `[tool call: ${block.name}]`
    case 'tool-result': {
      const content = projectContentBlocks(block.content)
      return content === '' ? '[empty tool result]' : content
    }
    default: {
      const unknown = block as { readonly type?: unknown }
      return `[unsupported content: ${String(unknown.type ?? 'unknown')}]`
    }
  }
}

function projectContentBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(projectContentBlock)
    .filter((value): value is string => value !== undefined && value !== '')
    .join('\n')
}

function projectAssistantContent(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(block => block.type === 'tool-call' || block.type === 'tool-result'
      ? undefined
      : projectContentBlock(block))
    .filter((value): value is string => value !== undefined && value !== '')
    .join('\n')
}

function userRowKind(event: SessionEvent<'user/message'>): TranscriptRowKind {
  return event.data.source.kind === 'user' ? 'user' : 'system'
}

function assistantKey(turn: number, step: number): string {
  return `assistant:${String(turn)}:${String(step)}`
}

function includesIndex(indexes: readonly number[], index: number): boolean {
  return indexes.includes(index)
}

function includesIndexOrReachedCapacity(indexes: readonly number[], index: number): boolean {
  return includesIndex(indexes, index) || indexes.length >= MAX_TRACKED_BLOCK_INDEXES
}

function trackIndex(indexes: readonly number[], index: number): readonly number[] {
  if (includesIndex(indexes, index) || indexes.length >= MAX_TRACKED_BLOCK_INDEXES) {
    return indexes
  }
  return Object.freeze([...indexes, index])
}

function renderAssistant(pending: PendingAssistant): string {
  if (pending.reasoning === '') return pending.text
  if (pending.text === '') return `Reasoning: ${pending.reasoning}`
  return `Reasoning: ${pending.reasoning}\n${pending.text}`
}

function updatePendingAssistant(
  pending: PendingAssistant,
  chunk: StreamChunk,
  maximum: number,
): PendingAssistant {
  let text = pending.text
  let reasoning = pending.reasoning
  let textIndexes = pending.textIndexes
  let reasoningIndexes = pending.reasoningIndexes
  let textTruncated = pending.textTruncated
  let reasoningTruncated = pending.reasoningTruncated

  switch (chunk.type) {
    case 'text-delta': {
      const next = appendBounded(text, chunk.text, maximum, textTruncated)
      text = next.text
      textTruncated = next.truncated
      textIndexes = trackIndex(textIndexes, chunk.index)
      break
    }
    case 'reasoning-delta': {
      const next = appendBounded(reasoning, chunk.text, maximum, reasoningTruncated)
      reasoning = next.text
      reasoningTruncated = next.truncated
      reasoningIndexes = trackIndex(reasoningIndexes, chunk.index)
      break
    }
    case 'block-end':
      if (
        chunk.block.type === 'text'
        && !includesIndexOrReachedCapacity(textIndexes, chunk.index)
      ) {
        const next = appendBounded(text, chunk.block.text, maximum, textTruncated)
        text = next.text
        textTruncated = next.truncated
        textIndexes = trackIndex(textIndexes, chunk.index)
      } else if (
        chunk.block.type === 'reasoning'
        && !includesIndexOrReachedCapacity(reasoningIndexes, chunk.index)
      ) {
        const next = appendBounded(
          reasoning,
          chunk.block.text,
          maximum,
          reasoningTruncated,
        )
        reasoning = next.text
        reasoningTruncated = next.truncated
        reasoningIndexes = trackIndex(reasoningIndexes, chunk.index)
      }
      break
    case 'block-start':
    case 'finish':
    case 'tool-call-delta':
    case 'usage':
      break
  }

  return Object.freeze({
    ...pending,
    reasoning,
    reasoningIndexes,
    reasoningTruncated,
    text,
    textIndexes,
    textTruncated,
  })
}

function turnEndContent(event: SessionEvent<'turn/end'>): string | undefined {
  const { reason, turn } = event.data
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'aborted':
      return `Turn ${String(turn)} cancelled (${reason.reason.kind})`
    case 'blocked':
      return `Turn ${String(turn)} blocked`
    case 'error':
      return `Turn ${String(turn)} failed: ${reason.error.code}: ${reason.error.message}`
    case 'interrupted':
      return `Turn ${String(turn)} was interrupted before this session resumed`
    case 'max-tokens':
      return `Turn ${String(turn)} reached the output token limit`
    default: {
      const unknown = reason as { readonly kind?: unknown }
      return `Turn ${String(turn)} ended (${String(unknown.kind ?? 'unknown')})`
    }
  }
}

function toolResultContent(event: SessionEvent<'tool/result'>): string {
  const resultBlock = event.data.message.content[0]
  const result = projectContentBlocks(resultBlock.content)
  return result === '' ? '[empty tool result]' : result
}

function pairedToolContent(call: string, result: string, maximum: number): BoundedText {
  const combined = `${call}\n${result}`
  if (combined.length <= maximum) return { text: combined, truncated: false }
  if (maximum === 1) return boundText(result, maximum)

  const available = maximum - 1
  let resultBudget = Math.min(result.length, Math.ceil(available / 2))
  let callBudget = Math.min(call.length, available - resultBudget)
  let remaining = available - callBudget - resultBudget

  const resultGrowth = Math.min(remaining, result.length - resultBudget)
  resultBudget += resultGrowth
  remaining -= resultGrowth
  callBudget += Math.min(remaining, call.length - callBudget)

  return {
    text: `${boundText(call, callBudget).text}\n${boundText(result, resultBudget).text}`,
    truncated: true,
  }
}

interface MutableFold {
  droppedRows: number
  pendingAssistants: PendingAssistant[]
  pendingTools: PendingTool[]
  rows: TranscriptRow[]
}

function updateRow(rows: TranscriptRow[], rowId: string, next: TranscriptRow): boolean {
  const index = rows.findIndex(candidate => candidate.id === rowId)
  if (index < 0) return false
  rows[index] = next
  return true
}

function removeRow(rows: TranscriptRow[], rowId: string): void {
  const index = rows.findIndex(candidate => candidate.id === rowId)
  if (index >= 0) rows.splice(index, 1)
}

function appendRow(fold: MutableFold, next: TranscriptRow, limits: ResolvedTranscriptLimits): void {
  fold.rows.push(next)
  const overflow = fold.rows.length - limits.maxRows
  if (overflow <= 0) return

  const removedIds = new Set(fold.rows.splice(0, overflow).map(item => item.id))
  fold.droppedRows += overflow
  fold.pendingAssistants = fold.pendingAssistants.filter(item => !removedIds.has(item.rowId))
  fold.pendingTools = fold.pendingTools.filter(item => !removedIds.has(item.rowId))
}

function closePendingForTurn(
  fold: MutableFold,
  turn: number,
  maximum: number,
): void {
  for (const pending of fold.pendingAssistants.filter(item => item.turn === turn)) {
    const existing = fold.rows.find(candidate => candidate.id === pending.rowId)
    if (existing !== undefined) {
      updateRow(
        fold.rows,
        pending.rowId,
        row(existing.id, existing.kind, existing.content, maximum, 'error'),
      )
    }
  }
  fold.pendingAssistants = fold.pendingAssistants.filter(item => item.turn !== turn)

  for (const pending of fold.pendingTools.filter(item => item.turn === turn)) {
    const existing = fold.rows.find(candidate => candidate.id === pending.rowId)
    if (existing !== undefined) {
      updateRow(
        fold.rows,
        pending.rowId,
        row(
          existing.id,
          existing.kind,
          `${existing.content}\n[tool result not recorded]`,
          maximum,
          'error',
        ),
      )
    }
  }
  fold.pendingTools = fold.pendingTools.filter(item => item.turn !== turn)
}

export function reduceTranscript(
  state: TranscriptState,
  event: SessionEvent,
): TranscriptState {
  if (event.seq < state.nextSeq) return state
  if (event.seq !== state.nextSeq) {
    throw new SessionEventSequenceError(state.nextSeq, event.seq)
  }

  const fold: MutableFold = {
    droppedRows: state.droppedRows,
    pendingAssistants: [...state.pendingAssistants],
    pendingTools: [...state.pendingTools],
    rows: [...state.rows],
  }
  const maximum = state.limits.maxRowChars

  switch (event.type) {
    case 'user/message': {
      const content = projectContentBlocks(event.data.content)
      appendRow(
        fold,
        row(
          `event:${String(event.seq)}`,
          userRowKind(event),
          content === '' ? '[empty message]' : content,
          maximum,
          'complete',
        ),
        state.limits,
      )
      break
    }
    case 'assistant/chunk': {
      const key = assistantKey(event.data.turn, event.data.step)
      const previous = fold.pendingAssistants.find(item => item.rowId === key)
        ?? Object.freeze({
          reasoning: '',
          reasoningIndexes: Object.freeze([]),
          reasoningTruncated: false,
          rowId: key,
          step: event.data.step,
          text: '',
          textIndexes: Object.freeze([]),
          textTruncated: false,
          turn: event.data.turn,
        })
      const next = updatePendingAssistant(previous, event.data.chunk, maximum)
      const content = renderAssistant(next)
      if (content !== '') {
        const nextRow = row(key, 'assistant', content, maximum, 'streaming')
        if (!updateRow(fold.rows, key, nextRow)) appendRow(fold, nextRow, state.limits)
      }
      fold.pendingAssistants = [
        ...fold.pendingAssistants.filter(item => item.rowId !== key),
        next,
      ]
      break
    }
    case 'assistant/message': {
      const key = assistantKey(event.data.turn, event.data.step)
      const content = projectAssistantContent(event.data.message.content)
      if (content === '') {
        removeRow(fold.rows, key)
      } else {
        const finalRow = row(key, 'assistant', content, maximum, 'complete')
        if (!updateRow(fold.rows, key, finalRow)) appendRow(fold, finalRow, state.limits)
      }
      fold.pendingAssistants = fold.pendingAssistants.filter(item => item.rowId !== key)
      break
    }
    case 'tool/call': {
      const callId = String(event.data.callId)
      const rowId = `tool:${callId}`
      const content = `${event.data.name} ${event.data.arguments}`.trim()
      const callRow = row(rowId, 'tool', content, maximum, 'pending')
      if (!updateRow(fold.rows, rowId, callRow)) appendRow(fold, callRow, state.limits)
      fold.pendingTools = [
        ...fold.pendingTools.filter(item => item.callId !== callId),
        Object.freeze({ callId, rowId, turn: event.data.turn }),
      ]
      break
    }
    case 'tool/result': {
      const callId = String(event.data.message.source.callId)
      const pending = fold.pendingTools.find(item => item.callId === callId)
      const rowId = pending?.rowId ?? `tool:${callId}`
      const existing = fold.rows.find(candidate => candidate.id === rowId)
      const result = toolResultContent(event)
      const content = existing === undefined
        ? { text: result, truncated: false }
        : pairedToolContent(existing.content, result, maximum)
      const resultRow = row(
        rowId,
        'tool',
        content.text,
        maximum,
        event.data.error === undefined && !event.data.message.content[0].isError
          ? 'complete'
          : 'error',
        content.truncated,
      )
      if (!updateRow(fold.rows, rowId, resultRow)) appendRow(fold, resultRow, state.limits)
      fold.pendingTools = fold.pendingTools.filter(item => item.callId !== callId)
      break
    }
    case 'turn/end': {
      closePendingForTurn(fold, event.data.turn, maximum)
      const content = turnEndContent(event)
      if (content !== undefined) {
        appendRow(
          fold,
          row(`event:${String(event.seq)}`, 'system', content, maximum, 'error'),
          state.limits,
        )
      }
      break
    }
    case 'compaction/start':
      appendRow(
        fold,
        row(
          `event:${String(event.seq)}`,
          'system',
          `Compaction ${String(event.data.compactionId)} started`,
          maximum,
          'pending',
        ),
        state.limits,
      )
      break
    case 'compaction/summary':
      appendRow(
        fold,
        row(
          `event:${String(event.seq)}`,
          'system',
          `Compaction summarized ${String(event.data.shadowedSeqs.length)} transcript events`,
          maximum,
          'complete',
        ),
        state.limits,
      )
      break
    case 'compaction/end':
      appendRow(
        fold,
        row(
          `event:${String(event.seq)}`,
          'system',
          event.data.error === undefined
            ? `Compaction ${String(event.data.compactionId)} completed`
            : `Compaction ${String(event.data.compactionId)} failed: ${event.data.error}`,
          maximum,
          event.data.error === undefined ? 'complete' : 'error',
        ),
        state.limits,
      )
      break
    case 'compaction/prune':
      appendRow(
        fold,
        row(
          `event:${String(event.seq)}`,
          'system',
          `Compaction pruned ${String(event.data.shadowedSeqs.length)} transcript events`,
          maximum,
          'complete',
        ),
        state.limits,
      )
      break
    case 'command/run': {
      const commandId = String(event.data.commandId)
      const rowId = `command:${commandId}`
      const commandRow = row(
        rowId,
        'system',
        `/${event.data.name}${event.data.args ?? ''}`,
        maximum,
        'pending',
      )
      if (!updateRow(fold.rows, rowId, commandRow)) {
        appendRow(fold, commandRow, state.limits)
      }
      break
    }
    case 'command/done': {
      const commandId = String(event.data.commandId)
      const rowId = `command:${commandId}`
      const existing = fold.rows.find(candidate => candidate.id === rowId)
      const outcome = event.data.text
        ?? (event.data.kind === 'success' ? 'Command completed' : 'Command failed')
      const content = existing === undefined
        ? { text: outcome, truncated: false }
        : pairedToolContent(existing.content, outcome, maximum)
      const commandRow = row(
        rowId,
        'system',
        content.text,
        maximum,
        event.data.kind === 'success' ? 'complete' : 'error',
        content.truncated,
      )
      if (!updateRow(fold.rows, rowId, commandRow)) {
        appendRow(fold, commandRow, state.limits)
      }
      break
    }
    case 'agent/inbox/spliced':
    case 'request/context':
    case 'request/header':
    case 'session/end-seed':
    case 'step/end':
    case 'step/start':
    case 'todo/write':
    case 'turn/start':
      break
    default: {
      const unknown = event as unknown as {
        readonly ignorable?: true
        readonly seq: number
        readonly type: string
      }
      if (unknown.ignorable !== true) {
        throw new UnsupportedSessionEventError(unknown.type, unknown.seq)
      }
      appendRow(
        fold,
        row(
          `event:${String(unknown.seq)}`,
          'system',
          `Skipped informational event: ${unknown.type}`,
          maximum,
          'complete',
        ),
        state.limits,
      )
    }
  }

  return Object.freeze({
    droppedRows: fold.droppedRows,
    limits: state.limits,
    nextSeq: state.nextSeq + 1,
    pendingAssistants: Object.freeze(fold.pendingAssistants),
    pendingTools: Object.freeze(fold.pendingTools),
    rows: Object.freeze(fold.rows),
  })
}

export function reduceTranscriptBatch(
  state: TranscriptState,
  events: readonly SessionEvent[],
): TranscriptState {
  return events.reduce(reduceTranscript, state)
}
