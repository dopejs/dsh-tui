import { describe, expect, it } from 'vitest'

import type { ScreenModel } from '../model/view-model'
import { renderInkFrame } from './ink-renderer'

const AGENTS_MD = [
  '# Project rules',
  '',
  'Do not pull WebGPU work before M2 is proven.',
  'Update docs/design.md when a change alters architecture.',
  'Keep this guide concise and operational.',
].join('\n')

function model(rows: ScreenModel['rows']): ScreenModel {
  return {
    rows,
    sessionId: 'session',
    status: 'idle',
    totalRows: rows.length,
  }
}

const injectedRow = {
  content: AGENTS_MD,
  id: 'row-1',
  kind: 'system' as const,
}

describe('injected context rendering (M6)', () => {
  // This is the defect from the field: a session opened on a wall of AGENTS.md
  // and system reminders instead of the conversation.
  it('folds an injected instruction file to one line plus a summary', () => {
    const output = renderInkFrame(model([injectedRow]), 80)
    expect(output).toContain('# Project rules')
    expect(output).toContain('+ 4 lines · ^E expand')
    expect(output).not.toContain('Do not pull WebGPU work')
  })

  it('shows everything once the row is expanded', () => {
    const output = renderInkFrame(model([injectedRow]), 80, new Set(['row-1']))
    expect(output).toContain('Do not pull WebGPU work')
    expect(output).toContain('Keep this guide concise')
    expect(output).not.toContain('expand')
  })

  // A short notice needs no affordance.
  it('leaves a short injection unfolded', () => {
    const output = renderInkFrame(
      model([{ content: 'File changed: src/a.ts', id: 'row-2', kind: 'system' }]),
      80,
    )
    expect(output).toContain('File changed: src/a.ts')
    expect(output).not.toContain('expand')
  })

  // Folding is for injected context; a real user turn is never hidden.
  it('never folds a user or assistant row', () => {
    const output = renderInkFrame(
      model([
        { content: AGENTS_MD, id: 'u', kind: 'user' },
        { content: AGENTS_MD, id: 'a', kind: 'assistant' },
      ]),
      80,
    )
    expect(output).not.toContain('expand')
  })
})
