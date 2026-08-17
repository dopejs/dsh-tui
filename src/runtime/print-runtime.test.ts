import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { InteractionRequiredError } from './print-runner'
import { refuseInteractions, turnFailureFrom } from './print-runtime'

type ApprovalListener = (
  request: { toolName: string },
  next: () => Promise<string>,
) => Promise<string>

class FakeContext {
  readonly approvals: ApprovalListener[] = []
  readonly questionProviders: { ask: () => Promise<unknown> }[] = []
  approvalDisposes = 0
  providerDisposes = 0
  #userQuestions: unknown

  constructor(withQuestions = true) {
    this.#userQuestions = withQuestions
      ? {
          registerProvider: (provider: { ask: () => Promise<unknown> }) => {
            this.questionProviders.push(provider)
            return () => {
              this.providerDisposes += 1
            }
          },
        }
      : undefined
  }

  get(key: string): unknown {
    return key === 'userQuestions' ? this.#userQuestions : undefined
  }

  on(event: string, listener: ApprovalListener): () => void {
    if (event !== 'approval/request') throw new Error(`unexpected event ${event}`)
    this.approvals.push(listener)
    return () => {
      this.approvalDisposes += 1
    }
  }
}

function asContext(fake: FakeContext): Context {
  return fake as unknown as Context
}

describe('refuseInteractions (M5.1)', () => {
  // There is no terminal to prompt on, and answering by default would grant
  // authority the user never gave.
  it('rejects an approval rather than allowing it', async () => {
    const fake = new FakeContext()
    const refusals = refuseInteractions(asContext(fake))

    const outcome = await fake.approvals[0]?.(
      { toolName: 'bash' },
      async () => 'allowed-once',
    )

    expect(outcome).toBe('rejected')
    expect(refusals.first()).toBeInstanceOf(InteractionRequiredError)
    expect(refusals.first()?.message).toContain('approval for bash')
    refusals.dispose()
  })

  it('refuses a question instead of answering it', async () => {
    const fake = new FakeContext()
    const refusals = refuseInteractions(asContext(fake))

    await expect(fake.questionProviders[0]?.ask()).rejects.toThrow('needs a human')
    expect(refusals.first()?.message).toContain('question that needs a human')
    refusals.dispose()
  })

  // The first refusal is what the run reports; later ones must not overwrite it.
  it('keeps the first refusal when several are hit', async () => {
    const fake = new FakeContext()
    const refusals = refuseInteractions(asContext(fake))

    await fake.approvals[0]?.({ toolName: 'bash' }, async () => 'allowed-once')
    await fake.approvals[0]?.({ toolName: 'write_file' }, async () => 'allowed-once')

    expect(refusals.first()?.message).toContain('bash')
    expect(refusals.first()?.message).not.toContain('write_file')
    refusals.dispose()
  })

  it('reports nothing when the run never needed a human', () => {
    const fake = new FakeContext()
    const refusals = refuseInteractions(asContext(fake))
    expect(refusals.first()).toBeUndefined()
    refusals.dispose()
  })

  it('still refuses approvals without a question service', async () => {
    const fake = new FakeContext(false)
    const refusals = refuseInteractions(asContext(fake))

    const outcome = await fake.approvals[0]?.({ toolName: 'bash' }, async () => 'allowed-once')
    expect(outcome).toBe('rejected')
    refusals.dispose()
    expect(fake.providerDisposes).toBe(0)
  })

  it('lifts every refusal on disposal', () => {
    const fake = new FakeContext()
    const refusals = refuseInteractions(asContext(fake))
    refusals.dispose()
    expect(fake.approvalDisposes).toBe(1)
    expect(fake.providerDisposes).toBe(1)
  })

  it('survives a composition without the approval waterfall', () => {
    const broken = {
      get: () => undefined,
      on: () => {
        throw new Error('no approval service')
      },
    } as unknown as Context
    const refusals = refuseInteractions(broken)
    expect(refusals.first()).toBeUndefined()
    expect(() => refusals.dispose()).not.toThrow()
  })

  it('does not fail the exit path when a disposer throws', () => {
    const fake = new FakeContext()
    const throwing = {
      get: (key: string) => fake.get(key),
      on: () => () => {
        throw new Error('dispose failed')
      },
    } as unknown as Context
    const refusals = refuseInteractions(throwing)
    expect(() => refusals.dispose()).not.toThrow()
  })

  it('registers exactly one approval refusal and one question provider', () => {
    const fake = new FakeContext()
    const spy = vi.spyOn(fake, 'on')
    const refusals = refuseInteractions(asContext(fake))
    expect(spy).toHaveBeenCalledOnce()
    expect(fake.questionProviders).toHaveLength(1)
    refusals.dispose()
  })
})

describe('turnFailureFrom (M5.1)', () => {
  const turnEnd = (reason: unknown) => ({
    data: { reason, turn: 0 },
    seq: 1,
    time: 1,
    type: 'turn/end',
  } as never)

  // Exit 0 with empty output reads as "the model had nothing to say", which is
  // the opposite of what a failed request means.
  it('reports a failed turn with its cause', () => {
    expect(turnFailureFrom(turnEnd({ error: { message: 'invalid api key' }, kind: 'error' })))
      .toBe('invalid api key')
  })

  it('reports a failed turn that carries no cause', () => {
    expect(turnFailureFrom(turnEnd({ kind: 'error' })))
      .toContain('without a reported cause')
  })

  it('reports a blocked turn', () => {
    expect(turnFailureFrom(turnEnd({ kind: 'blocked' }))).toContain('blocked')
  })

  it('treats a completed or aborted turn as no failure', () => {
    expect(turnFailureFrom(turnEnd({ kind: 'completed' }))).toBeUndefined()
    // Cancellation is reported by the run's own abort path, not as a failure.
    expect(turnFailureFrom(turnEnd({ kind: 'aborted', reason: 'user' }))).toBeUndefined()
  })

  it('ignores every other durable event', () => {
    expect(turnFailureFrom({ data: {}, seq: 1, time: 1, type: 'turn/start' } as never))
      .toBeUndefined()
    expect(turnFailureFrom({ data: null, seq: 1, time: 1, type: 'turn/end' } as never))
      .toBeUndefined()
  })
})

