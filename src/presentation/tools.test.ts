import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { TranscriptController } from '../model/transcript-controller'
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
): SessionEvent<'tool/result'> {
  return {
    data: {
      message: {
        content: [{
          content: [{ text, type: 'text' }],
          toolCallId: id,
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
  limits: { readonly maxLineChars?: number; readonly maxLines?: number } = {},
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
})
