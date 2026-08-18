import { describe, expect, it } from 'vitest'

import { renderToString } from 'ink'

import type { ScreenModel } from '../model/view-model'

import { Frame, StatusFooter, renderInkFrame } from './ink-renderer'

const BASE = {
  sessionId: 'session-layout',
  status: 'idle' as const,
  totalRows: 2,
}

function lines(output: string): string[] {
  return output.split('\n').map(line => line.trimEnd())
}

function indexOfLine(output: string, needle: string): number {
  return lines(output).findIndex(line => line.includes(needle))
}

describe('screen layout (M6.9)', () => {
  // A model thinking is part of the exchange being read. Reporting it in the
  // status area below the composer makes the user look away from the place the
  // reply is about to appear -- and nothing asserted where it went, which is
  // why it sat in the status area unnoticed.
  it('puts the working line at the foot of the conversation, not in the status area', () => {
    const model: ScreenModel = {
      ...BASE,
      rows: [
        { content: 'hello', id: 'u', kind: 'user' as const },
        { content: 'thinking about it', id: 'a', kind: 'assistant' as const },
      ],
      status: 'busy' as const,
      working: ['2.5s', '^C cancel'],
    }

    // Asserting ownership, not just order: the two are adjacent in a combined
    // render, so an order assertion alone stays green with the line back in
    // the status area. The composer sits between them on the real screen.
    const conversation = renderToString(<Frame columns={70} model={model} />, { columns: 70 })
    const status = renderToString(<StatusFooter columns={70} model={model} />, { columns: 70 })

    expect(conversation).toContain('working ·')
    expect(status).not.toContain('working ·')
    expect(indexOfLine(conversation, 'working ·'))
      .toBeGreaterThan(indexOfLine(conversation, 'thinking about it'))
  })

  it('says nothing about work while the agent is idle', () => {
    const output = renderInkFrame({
      ...BASE,
      rows: [{ content: 'hello', id: 'u', kind: 'user' }],
      totalRows: 1,
    }, 70)
    expect(output).not.toContain('working ·')
  })

  // Injected reminders are what the model was given, so they stay reachable --
  // but a turn carrying three of them used to spend six lines saying nothing
  // the user asked for, because each fold summary claimed a line of its own.
  it('folds an injected reminder onto a single line', () => {
    const injected = `<system-reminder>\n${Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n')}`
    const output = renderInkFrame({
      ...BASE,
      rows: [{ content: injected, id: 's', kind: 'system' }],
      totalRows: 1,
    }, 70)

    const rendered = lines(output).filter(line => line.includes('<system-reminder>'))
    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toContain('40 lines')
    // The body is folded away, not merely pushed off screen.
    expect(output).not.toContain('line 12')
  })

  it('still expands that reminder on request', () => {
    const injected = `<system-reminder>\n${Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join('\n')}`
    const output = renderInkFrame({
      ...BASE,
      rows: [{ content: injected, id: 's', kind: 'system' }],
      totalRows: 1,
    }, 70, new Set(['s']))
    expect(output).toContain('line 12')
  })
})
