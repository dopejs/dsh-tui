import type {} from '@deepseek-ai/dsh-compaction/types'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'

import {
  createTranscriptState,
  reduceTranscript,
  reduceTranscriptBatch,
  SessionEventSequenceError,
  UnsupportedSessionEventError,
} from './transcript-reducer'

type EventType = SessionEvent['type']
type MessageId = SessionEvent<'user/message'>['data']['id']
type CallId = SessionEvent<'tool/call'>['data']['callId']
type CompactionId = SessionEvent<'compaction/start'>['data']['compactionId']

function event<T extends EventType>(
  seq: number,
  type: T,
  data: SessionEvent<T>['data'],
): SessionEvent<T> {
  return { data, seq, time: 1_700_000_000_000 + seq, type } as SessionEvent<T>
}

function userMessage(
  seq: number,
  text: string,
  source: SessionEvent<'user/message'>['data']['source'] = { kind: 'user' },
): SessionEvent<'user/message'> {
  return event(seq, 'user/message', {
    content: [{ text, type: 'text' }],
    id: `user-${String(seq)}` as MessageId,
    role: 'user',
    source,
  })
}

function assistantChunk(
  seq: number,
  chunk: SessionEvent<'assistant/chunk'>['data']['chunk'],
  turn = 0,
  step = 0,
): SessionEvent<'assistant/chunk'> {
  return event(seq, 'assistant/chunk', { chunk, step, turn })
}

function assistantMessage(
  seq: number,
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  turn = 0,
  step = 0,
): SessionEvent<'assistant/message'> {
  return event(seq, 'assistant/message', {
    message: {
      content,
      id: `assistant-${String(seq)}` as MessageId,
      role: 'assistant',
      source: { kind: 'model', model: 'fixture', provider: 'fixture' },
    },
    step,
    turn,
  })
}

function toolCall(seq: number, callId: CallId, argumentsText = '{"path":"a"}') {
  return event(seq, 'tool/call', {
    arguments: argumentsText,
    callId,
    name: 'read_file',
    step: 0,
    turn: 0,
  })
}

function toolResult(
  seq: number,
  callId: CallId,
  text: string,
  options: { readonly eventError?: boolean; readonly resultError?: boolean } = {},
) {
  return event(seq, 'tool/result', {
    ...(options.eventError ? { error: { code: 'FAILED', name: 'FixtureError' } } : {}),
    message: {
      content: [{
        content: [{ text, type: 'text' }],
        ...(options.resultError ? { isError: true } : {}),
        toolCallId: callId,
        type: 'tool-result',
      }],
      id: `tool-${String(seq)}` as MessageId,
      role: 'user',
      source: { callId, kind: 'tool' },
    },
    step: 0,
    turn: 0,
  })
}

describe('transcript reducer', () => {
  it('validates limits and creates a deeply stable empty state', () => {
    const state = createTranscriptState({ maxRowChars: 80, maxRows: 12 })

    expect(state).toEqual({
      droppedRows: 0,
      limits: { maxRowChars: 80, maxRows: 12 },
      nextSeq: 0,
      pendingAssistants: [],
      pendingTools: [],
      rows: [],
    })
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.limits)).toBe(true)
    expect(() => createTranscriptState({ maxRows: 0 })).toThrow(RangeError)
    expect(() => createTranscriptState({ maxRowChars: Number.NaN })).toThrow(RangeError)
  })

  it('projects human and plugin messages without mutating the prior state', () => {
    const initial = createTranscriptState()
    const human = reduceTranscript(initial, userMessage(0, 'hello'))
    const plugin = reduceTranscript(
      human,
      userMessage(1, 'workspace changed', { kind: 'plugin', plugin: 'watcher' }),
    )

    expect(initial.rows).toEqual([])
    expect(plugin.rows).toEqual([
      { content: 'hello', id: 'event:0', kind: 'user', status: 'complete' },
      { content: 'workspace changed', id: 'event:1', kind: 'system', status: 'complete' },
    ])
    expect(Object.isFrozen(plugin.rows)).toBe(true)
    expect(plugin.rows.every(Object.isFrozen)).toBe(true)
  })

  it('reconciles interleaved streaming blocks with the final assistant anchor', () => {
    const streamed = reduceTranscriptBatch(createTranscriptState(), [
      assistantChunk(0, { blockType: 'reasoning', index: 0, type: 'block-start' }),
      assistantChunk(1, { index: 0, text: 'think', type: 'reasoning-delta' }),
      assistantChunk(2, { blockType: 'text', index: 1, type: 'block-start' }),
      assistantChunk(3, { index: 1, text: 'hel', type: 'text-delta' }),
      assistantChunk(4, { index: 1, text: 'lo', type: 'text-delta' }),
      assistantChunk(5, { block: { text: 'hello', type: 'text' }, index: 1, type: 'block-end' }),
    ])

    // Reasoning travels beside the answer, not concatenated into it, so the
    // renderer can fold it and the clipboard can leave it out.
    expect(streamed.rows).toEqual([{
      content: 'hello',
      id: 'assistant:0:0',
      kind: 'assistant',
      reasoning: 'think',
      status: 'streaming',
    }])
    expect(streamed.pendingAssistants).toHaveLength(1)

    const complete = reduceTranscript(
      streamed,
      assistantMessage(6, [
        { text: 'think', type: 'reasoning' },
        { text: 'hello!', type: 'text' },
        {
          arguments: '{}',
          id: 'call-in-message' as CallId,
          name: 'ignored_tool_card',
          type: 'tool-call',
        },
      ]),
    )

    // Reasoning travels beside the answer, never inside it. Folding it into
    // the content here is what made a real reply read as a continuation of the
    // model's scratch work, with the fold key inert because the row no longer
    // carried any reasoning of its own.
    expect(complete.rows).toEqual([{
      content: 'hello!',
      id: 'assistant:0:0',
      kind: 'assistant',
      reasoning: 'think',
      status: 'complete',
    }])
    expect(complete.pendingAssistants).toEqual([])
  })

  it('uses block-end content when no deltas arrived and does not mistake user text for truncation', () => {
    const suffixText = 'literal … [truncated]'
    const state = reduceTranscriptBatch(createTranscriptState({ maxRowChars: 100 }), [
      assistantChunk(0, { index: 0, text: suffixText, type: 'text-delta' }),
      assistantChunk(1, { index: 0, text: ' still streaming', type: 'text-delta' }),
      assistantChunk(2, { block: { text: 'fallback', type: 'text' }, index: 1, type: 'block-end' }),
    ])

    expect(state.rows[0]?.content).toBe(`${suffixText} still streamingfallback`)
  })

  it('bounds stream indexes without duplicating later block-end payloads', () => {
    const events = Array.from({ length: 130 }, (_, index) =>
      assistantChunk(index, { index, text: 'x', type: 'text-delta' }))
    events.push(assistantChunk(130, {
      block: { text: 'duplicate', type: 'text' },
      index: 129,
      type: 'block-end',
    }))

    const state = reduceTranscriptBatch(createTranscriptState({ maxRowChars: 500 }), events)
    expect(state.rows[0]?.content).toBe('x'.repeat(130))
  })

  it('correlates tool results, preserves result visibility under bounds, and records failures', () => {
    const callId = 'call-1' as CallId
    const state = reduceTranscriptBatch(createTranscriptState({ maxRowChars: 40 }), [
      toolCall(0, callId, `{"payload":"${'x'.repeat(80)}"}`),
      toolResult(1, callId, `result-${'y'.repeat(80)}`, { resultError: true }),
    ])

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      id: 'tool:call-1',
      kind: 'tool',
      status: 'error',
      truncated: true,
    })
    expect(state.rows[0]?.content).toContain('\n')
    expect(state.rows[0]?.content).toContain('result')
    expect(state.rows[0]?.content.length).toBeLessThanOrEqual(40)
    expect(state.pendingTools).toEqual([])
  })

  it('renders orphan tool results and closes unfinished work at turn end', () => {
    const firstCall = 'call-pending' as CallId
    const orphanCall = 'call-orphan' as CallId
    const state = reduceTranscriptBatch(createTranscriptState(), [
      assistantChunk(0, { index: 0, text: 'partial', type: 'text-delta' }),
      toolCall(1, firstCall),
      toolResult(2, orphanCall, 'orphan output'),
      event(3, 'turn/end', { reason: { kind: 'completed' }, turn: 0 }),
    ])

    expect(state.rows).toEqual([
      {
        content: 'partial',
        id: 'assistant:0:0',
        kind: 'assistant',
        status: 'error',
      },
      {
        content: 'read_file {"path":"a"}\n[tool result not recorded]',
        id: 'tool:call-pending',
        kind: 'tool',
        status: 'error',
      },
      {
        content: 'orphan output',
        id: 'tool:call-orphan',
        kind: 'tool',
        status: 'complete',
      },
    ])
    expect(state.pendingAssistants).toEqual([])
    expect(state.pendingTools).toEqual([])
  })

  it.each([
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'Turn 0 cancelled (user)'],
    [{ kind: 'blocked' }, 'Turn 0 blocked'],
    [{ error: { code: 'BAD', message: 'broken' }, kind: 'error' }, 'Turn 0 failed: BAD: broken'],
    [{ kind: 'interrupted' }, 'Turn 0 was interrupted before this session resumed'],
    [{ kind: 'max-tokens' }, 'Turn 0 reached the output token limit'],
  ] as const)('projects an unsuccessful turn ending %#', (reason, expected) => {
    const state = reduceTranscript(
      createTranscriptState(),
      event(0, 'turn/end', { reason, turn: 0 }),
    )
    expect(state.rows[0]?.content).toBe(expected)
    expect(state.rows[0]?.status).toBe('error')
  })

  it('keeps prior transcript rows while rendering compaction lifecycle markers', () => {
    const compactionId = 'compact-1' as CompactionId
    const replacement = {
      ...userMessage(3, 'summary checkpoint', { kind: 'plugin', plugin: 'compact' }),
      sourceEventSeqs: [0],
      surfaceOp: { end: 0, op: 'replace', start: 0 },
    } as SessionEvent<'user/message'>
    const state = reduceTranscriptBatch(createTranscriptState(), [
      userMessage(0, 'keep me'),
      event(1, 'compaction/start', { compactionId, turn: null }),
      event(2, 'compaction/summary', {
        compactionId,
        llmStreamCall: true,
        model: 'fixture',
        provider: 'fixture',
        rawOutput: [{ text: 'summary', type: 'text' }],
        shadowedRange: { end: 0, start: 0 },
        shadowedSeqs: [0],
        shadowedTokenCount: 2,
        summary: [{ text: 'summary', type: 'text' }],
      }),
      replacement,
      event(4, 'compaction/end', { compactionId, turn: null }),
      event(5, 'compaction/prune', {
        shadowedRange: { end: 0, start: 0 },
        shadowedSeqs: [0],
        shadowedTokenCount: 2,
      }),
    ])

    expect(state.rows.map(item => item.content)).toEqual([
      'keep me',
      'Compaction compact-1 started',
      'Compaction summarized 1 transcript events',
      'summary checkpoint',
      'Compaction compact-1 completed',
      'Compaction pruned 1 transcript events',
    ])
  })

  it('renders durable command lifecycle and ignores durable inbox bookkeeping', () => {
    const commandId = CommandId('command-1')
    const state = reduceTranscriptBatch(createTranscriptState(), [
      event(0, 'agent/inbox/spliced', {
        inserted: [],
        start: 0,
        target: 'next-turn',
      }),
      event(1, 'command/run', {
        args: '  exact args',
        commandId,
        name: 'fixture',
        source: { kind: 'user' },
      }),
      event(2, 'command/done', {
        commandId,
        kind: 'success',
        text: 'command output',
      }),
    ])

    expect(state.rows).toEqual([{
      content: '/fixture  exact args\ncommand output',
      id: 'command:command-1',
      kind: 'system',
      status: 'complete',
    }])
    expect(state.nextSeq).toBe(3)
  })

  it('renders nested code dispatches and durable approval audit pairs', () => {
    const rootCallId = 'root-call' as CallId
    const subCallId = 'sub-call' as CallId
    const approvalId = ApprovalRequestId('approval-1')
    const state = reduceTranscriptBatch(createTranscriptState(), [
      event(0, 'tool/code-dispatch-start', {
        arguments: { path: 'a.ts' },
        name: 'read',
        parentCallId: rootCallId,
        rootCallId,
        subCallId,
      }),
      event(1, 'tool/code-dispatch', {
        arguments: { path: 'a.ts' },
        content: [{ text: 'file content', type: 'text' }],
        isError: false,
        name: 'read',
        parentCallId: rootCallId,
        rootCallId,
        subCallId,
      }),
      event(2, 'approval/asked', {
        id: approvalId,
        reason: 'outside sandbox',
        toolName: 'bash',
      }),
      event(3, 'approval/decided', {
        id: approvalId,
        outcome: 'rejected',
      }),
      event(4, 'approval/policy', { policy: 'never' }),
    ])

    expect(state.rows).toEqual([
      {
        content: 'read {\n  "path": "a.ts"\n}\nfile content',
        id: 'tool:sub-call',
        kind: 'tool',
        status: 'complete',
      },
      {
        content: 'Approval requested for bash: outside sandbox\nApproval rejected',
        id: 'approval:approval-1',
        kind: 'system',
        status: 'error',
      },
      {
        content: 'Approval policy changed to never',
        id: 'event:4',
        kind: 'system',
        status: 'complete',
      },
    ])
  })

  it('deduplicates replay overlap and refuses sequence gaps or unknown required events', () => {
    const first = userMessage(0, 'once')
    const state = reduceTranscript(createTranscriptState(), first)

    expect(reduceTranscript(state, first)).toBe(state)
    expect(() => reduceTranscript(state, userMessage(2, 'gap')))
      .toThrow(SessionEventSequenceError)

    const required = { data: {}, seq: 1, time: 1, type: 'future/required' } as SessionEvent
    expect(() => reduceTranscript(state, required)).toThrow(UnsupportedSessionEventError)

    const ignorable = {
      data: {},
      ignorable: true,
      seq: 1,
      time: 1,
      type: 'future/informational',
    } as unknown as SessionEvent
    expect(reduceTranscript(state, ignorable).rows[1]?.content)
      .toBe('Skipped informational event: future/informational')
  })

  it('accepts Harness-known domain events owned by separate projections', () => {
    const permissionEvent = {
      data: { preset: 'workspace-write' },
      seq: 0,
      time: 0,
      type: 'permission/preset',
    } as unknown as SessionEvent
    const state = reduceTranscript(createTranscriptState(), permissionEvent)

    expect(state.nextSeq).toBe(1)
    expect(state.rows).toEqual([])
  })

  it('evicts old rows and their pending correlations within configured bounds', () => {
    const callId = 'evicted-call' as CallId
    const state = reduceTranscriptBatch(createTranscriptState({ maxRows: 2 }), [
      toolCall(0, callId),
      userMessage(1, 'second'),
      userMessage(2, 'third'),
    ])

    expect(state.rows.map(item => item.content)).toEqual(['second', 'third'])
    expect(state.droppedRows).toBe(1)
    expect(state.pendingTools).toEqual([])
  })
})
