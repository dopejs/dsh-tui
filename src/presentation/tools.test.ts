import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { TranscriptController } from '../model/transcript-controller'
import { ChangeIndexController, type ChangePresentationIntent } from '../model/change-index-controller'
import { createTranscriptState } from '../model/transcript-reducer'
import { ToolTranscriptProjector } from './tools'

function call(seq: number, id: CallId, name = 'fixture'): SessionEvent<'tool/call'> {
  return {
    data: { arguments: '{"command":"echo hi"}', callId: id, name, step: 0, turn: 0 },
    seq,
    time: seq,
    type: 'tool/call',
  }
}

function result(
  seq: number,
  id: CallId,
  text = 'raw output',
  isError = false,
): SessionEvent<'tool/result'> {
  return {
    data: {
      message: {
        content: [{
          content: [{ text, type: 'text' }],
          toolCallId: id,
          ...(isError ? { isError: true } : {}),
          type: 'tool-result',
        }],
        id: `result-${String(seq)}` as MessageId,
        role: 'user',
        source: { callId: id, kind: 'tool' },
      },
      step: 0,
      turn: 0,
    },
    seq,
    time: seq,
    type: 'tool/result',
  }
}

function fixture(
  definition: Partial<Pick<ToolDefinition, 'presentCall' | 'presentResult'>>,
  limits: {
    readonly maxLineChars?: number
    readonly maxLines?: number
    readonly onChangePresentation?: (intent: ChangePresentationIntent) => void
  } = {},
) {
  const agent = { id: 'agent' } as unknown as Agent
  const get = vi.fn(() => definition as ToolDefinition)
  const errors: unknown[] = []
  const projector = new ToolTranscriptProjector({
    agent,
    ...limits,
    reportError: error => errors.push(error),
    tools: { get },
  })
  return { agent, errors, get, projector }
}

describe('ToolTranscriptProjector', () => {
  it('resolves terminal presentation in the exact agent scope and integrates with the store', async () => {
    const id = 'terminal-call' as CallId
    const mounted = fixture({
      presentCall: () => ({
        card: 'terminal',
        cwd: 'workspace',
        description: 'Print greeting',
        title: 'echo hi',
      }),
      presentResult: () => ({ card: 'terminal', exitCode: 0, output: 'hi' }),
    })
    const controller = new TranscriptController({ projectBatch: mounted.projector.reduceBatch })

    controller.accept([call(0, id), result(1, id)])

    expect(controller.getSnapshot().rows[0]?.toolCard).toEqual({
      card: 'terminal',
      lines: ['Print greeting', 'cwd: workspace', '$ echo hi', 'hi', 'exit: 0'],
      title: 'echo hi',
    })
    expect(mounted.get).toHaveBeenCalledWith('fixture', mounted.agent)
    await controller.dispose()
  })

  it.each<[string, ToolResultView, string[]]>([
    ['diff', {
      card: 'diff',
      diffs: [{ newText: 'new', oldText: 'old', path: 'a.ts' }],
      title: 'Edit a.ts',
    }, ['--- a.ts', '- old', '+ new']],
    ['search', {
      card: 'search',
      paths: ['a.ts', 'b.ts'],
      shape: 'paths',
      total: 3,
      truncated: true,
    }, ['a.ts', 'b.ts', '3 total (truncated)']],
    ['read', {
      card: 'read',
      lines: [{ number: 4, text: 'const x = 1' }],
      offset: 4,
      path: 'a.ts',
      totalLines: 10,
    }, ['a.ts · 1 of 10 lines', '   4 │ const x = 1']],
    ['web', {
      answer: 'answer',
      card: 'web',
      kind: 'search',
      sources: [{ title: 'Source', url: 'https://example.test' }],
      truncated: false,
    }, ['answer', 'Source · https://example.test']],
  ])('normalizes the %s result card', (card, presented, lines) => {
    const id = `${card}-call` as CallId
    const mounted = fixture({
      presentCall: () => ({ card: 'generic', title: 'Pending' }),
      presentResult: () => presented,
    })
    const state = mounted.projector.reduceBatch(createTranscriptState(), [call(0, id), result(1, id)])

    expect(state.rows[0]?.toolCard).toMatchObject({ card, lines })
  })

  it('keeps durable fetch content in the web result card', () => {
    const id = 'web-fetch-call' as CallId
    const mounted = fixture({
      presentResult: () => ({
        card: 'web',
        kind: 'fetch',
        statusCode: 200,
        truncated: false,
        url: 'https://example.test/page',
      }),
    })
    const state = mounted.projector.reduceBatch(createTranscriptState(), [
      call(0, id),
      result(1, id, 'fetched page body'),
    ])

    expect(state.rows[0]?.toolCard).toEqual({
      card: 'web',
      lines: ['200 https://example.test/page', 'fetched page body'],
      title: 'fixture',
    })
  })

  it('bounds card detail and reports presenter failures without breaking durable fallback', () => {
    const id = 'broken-call' as CallId
    const mounted = fixture({
      presentCall: () => { throw new Error('presenter failed') },
    }, { maxLineChars: 5, maxLines: 1 })
    const state = mounted.projector.reduceBatch(createTranscriptState(), [call(0, id)])

    expect(state.rows[0]?.toolCard).toBeUndefined()
    expect(state.rows[0]?.content).toContain('fixture')
    expect(mounted.errors).toHaveLength(1)

    const bounded = fixture({
      presentCall: () => ({
        card: 'generic',
        content: [{ text: '123456\nsecond', type: 'text' }],
        title: 'Bounded',
      }),
    }, { maxLineChars: 5, maxLines: 1 })
    const boundedState = bounded.projector.reduceBatch(
      createTranscriptState(),
      [call(0, 'bounded-call' as CallId)],
    )
    expect(boundedState.rows[0]?.toolCard).toEqual({
      card: 'generic',
      lines: ['1234…'],
      title: 'Boun…',
      truncated: true,
    })
  })

  it('falls back on malformed arguments and keeps batch sequence atomic', () => {
    const id = 'malformed-call' as CallId
    const mounted = fixture({ presentCall: vi.fn() })
    const malformed = {
      ...call(0, id),
      data: { ...call(0, id).data, arguments: '{broken' },
    }
    const state = mounted.projector.reduceBatch(createTranscriptState(), [malformed])

    expect(state.nextSeq).toBe(1)
    expect(state.rows[0]?.toolCard).toBeUndefined()
    expect(mounted.errors).toHaveLength(1)
  })

  it('keeps durable raw result content when a call presenter has no result presenter', () => {
    const id = 'fallback-result' as CallId
    const mounted = fixture({
      presentCall: () => ({ card: 'terminal', title: 'echo hi' }),
    })
    const state = mounted.projector.reduceBatch(createTranscriptState(), [
      call(0, id),
      result(1, id, 'raw result stays visible'),
    ])

    expect(state.rows[0]?.toolCard).toEqual({
      card: 'generic',
      lines: ['raw result stays visible'],
      title: 'echo hi',
    })
  })

  it('emits public diff intents for planned and applied durable events', () => {
    const id = 'change-call' as CallId
    const changes: ChangePresentationIntent[] = []
    const mounted = fixture({
      presentCall: () => ({
        card: 'diff',
        diffs: [{ newText: 'planned', oldText: 'old', path: 'src/a.ts' }],
        title: 'Plan a.ts',
      }),
      presentResult: () => ({
        card: 'diff',
        diffs: [{ newText: 'applied', oldText: 'old', path: 'src/a.ts' }],
        title: 'Applied a.ts',
      }),
    }, { onChangePresentation: change => changes.push(change) })

    mounted.projector.reduceBatch(createTranscriptState(), [call(0, id), result(1, id)])

    expect(changes).toEqual([{
      callId: id,
      diffs: [{ newText: 'planned', oldText: 'old', path: 'src/a.ts' }],
      eventSeq: 0,
      phase: 'planned',
      rowId: `tool:${id}`,
      title: 'Plan a.ts',
    }, {
      callId: id,
      diffs: [{ newText: 'applied', oldText: 'old', path: 'src/a.ts' }],
      eventSeq: 1,
      phase: 'applied',
      rowId: `tool:${id}`,
      title: 'Applied a.ts',
    }])
  })

  it('builds the same change index across replay and live batch partitions', () => {
    const id = 'partitioned-change' as CallId
    const definition = {
      presentCall: () => ({
        card: 'diff' as const,
        diffs: [{ newText: 'planned', oldText: 'old', path: 'src/a.ts' }],
        title: 'Plan a.ts',
      }),
      presentResult: () => ({
        card: 'diff' as const,
        diffs: [{ newText: 'applied', oldText: 'old', path: 'src/a.ts' }],
        title: 'Applied a.ts',
      }),
    }
    const replayIndex = new ChangeIndexController()
    const replay = fixture(definition, { onChangePresentation: change => replayIndex.record(change) })
    replay.projector.reduceBatch(createTranscriptState(), [call(0, id), result(1, id)])

    const liveIndex = new ChangeIndexController()
    const live = fixture(definition, { onChangePresentation: change => liveIndex.record(change) })
    const pending = live.projector.reduceBatch(createTranscriptState(), [call(0, id)])
    live.projector.reduceBatch(pending, [result(1, id)])

    expect(liveIndex.getSnapshot()).toEqual(replayIndex.getSnapshot())
    replayIndex.dispose()
    liveIndex.dispose()
  })

  it.each([
    [false, 'unverified'],
    [true, 'failed'],
  ] as const)('does not claim an applied diff without a result presentation', (isError, phase) => {
    const id = `fallback-${phase}` as CallId
    const changes: ChangePresentationIntent[] = []
    const mounted = fixture({
      presentCall: () => ({
        card: 'diff',
        diffs: [{ newText: 'planned', oldText: 'old', path: 'a.ts' }],
        title: 'Edit a.ts',
      }),
    }, { onChangePresentation: change => changes.push(change) })

    mounted.projector.reduceBatch(createTranscriptState(), [call(0, id), result(1, id, 'done', isError)])

    expect(changes.at(-1)?.phase).toBe(phase)
  })

  it('contains change-consumer failures without interrupting transcript projection', () => {
    const id = 'consumer-failure' as CallId
    const mounted = fixture({
      presentCall: () => ({
        card: 'diff',
        diffs: [{ newText: 'new', oldText: 'old', path: 'a.ts' }],
        title: 'Edit a.ts',
      }),
      presentResult: () => ({ card: 'generic', title: 'Done' }),
    }, {
      onChangePresentation: () => { throw new Error('index failed') },
    })

    const state = mounted.projector.reduceBatch(createTranscriptState(), [call(0, id), result(1, id)])

    expect(state.nextSeq).toBe(2)
    expect(state.rows[0]?.toolCard?.title).toBe('Done')
    expect(mounted.errors).toHaveLength(2)
  })
})
