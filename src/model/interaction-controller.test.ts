import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'

import { InteractionController } from './interaction-controller'

function agent(): Agent {
  return { id: 'root-agent' } as unknown as Agent
}

describe('InteractionController', () => {
  it('publishes and answers one approval', async () => {
    const controller = new InteractionController()
    const changed = vi.fn()
    controller.subscribe(changed)
    const abort = new AbortController()
    const answer = controller.askApproval({
      agent: agent(),
      reason: 'needs access',
      toolName: 'bash',
    }, abort.signal)

    expect(controller.getSnapshot()).toEqual({
      agentLabel: 'root-agent',
      kind: 'approval',
      reason: 'needs access',
      toolName: 'bash',
    })
    controller.answerApproval('allowed-once')
    await expect(answer).resolves.toBe('allowed-once')
    expect(controller.getSnapshot()).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('snapshots questions and returns structured answers', async () => {
    const controller = new InteractionController()
    const abort = new AbortController()
    const answering = controller.askQuestions({
      agent: agent(),
      questions: [{
        id: 'choice',
        options: [{ label: 'A' }],
        question: 'Choose?',
      }],
    }, abort.signal)
    const snapshot = controller.getSnapshot()
    expect(snapshot).toMatchObject({ agentLabel: 'root-agent', kind: 'questions' })
    expect(Object.isFrozen(snapshot)).toBe(true)
    if (snapshot?.kind === 'questions') {
      expect(Object.isFrozen(snapshot.questions)).toBe(true)
      expect(Object.isFrozen(snapshot.questions[0]?.options)).toBe(true)
    }

    const answer = { answers: [{ id: 'choice', selected: ['A'] }] }
    controller.answerQuestions(answer)
    await expect(answering).resolves.toBe(answer)
    controller.dispose()
  })

  it('rejects overlap and clears an aborted interaction', async () => {
    const controller = new InteractionController()
    const abort = new AbortController()
    const first = controller.askApproval({ agent: agent(), toolName: 'bash' }, abort.signal)
    await expect(controller.askQuestions({ questions: [] }, new AbortController().signal))
      .rejects.toThrow('already occupied')
    abort.abort(new Error('cancelled'))
    await expect(first).rejects.toThrow('cancelled')
    expect(controller.getSnapshot()).toBeUndefined()
    controller.dispose()
  })

  it('contains subscriber errors and rejects pending work on disposal', async () => {
    const errors: unknown[] = []
    const controller = new InteractionController(error => errors.push(error))
    controller.subscribe(() => { throw new Error('subscriber failed') })
    const pending = controller.askApproval(
      { agent: agent(), toolName: 'bash' },
      new AbortController().signal,
    )

    controller.dispose()
    await expect(pending).rejects.toThrow('Interaction controller disposed')
    expect(errors).toHaveLength(1)
    expect(() => controller.subscribe(() => undefined)).toThrow('disposed')
  })
})
