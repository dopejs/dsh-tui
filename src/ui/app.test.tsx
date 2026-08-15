import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'

import type { AgentStatusStore } from '../model/agent-status-controller'
import { InteractionController } from '../model/interaction-controller'
import { TranscriptController } from '../model/transcript-controller'
import type { InputController } from '../runtime/input-controller'
import { InteractiveTui } from './app'

const status: AgentStatusStore = {
  getSnapshot: () => 'idle',
  subscribe: () => () => undefined,
}

function fakeInput(): InputController {
  return {
    cancelAgent: () => undefined,
    cancelCommand: () => false,
    commandPending: false,
    submit: async () => ({
      code: 'empty',
      kind: 'rejected',
      message: 'Input must not be empty',
    }),
  } as unknown as InputController
}

function renderApp(transcript: TranscriptController, interaction: InteractionController) {
  return renderToString(
    <InteractiveTui
      columns={52}
      input={fakeInput()}
      interaction={interaction}
      modelLabel="fixture/model"
      onQuit={() => undefined}
      sessionId="session-app"
      status={status}
      terminalRows={14}
      transcript={transcript}
      workspace="/fixture/workspace"
    />,
    { columns: 52 },
  )
}

describe('InteractiveTui', () => {
  it('renders the bounded composer chrome', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()

    expect(renderApp(transcript, interaction)).toMatchInlineSnapshot(`
      "dsh-tui · session-app · idle
      fixture/model · /fixture/workspace
      transcript empty
      ›
      Enter send · ^S steer · ^C cancel · /exit quit"
    `)

    interaction.dispose()
    await transcript.dispose()
  })

  it('renders an explicit fail-closed approval choice', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const pending = interaction.askApproval({
      agent: { id: 'root-agent' } as unknown as Agent,
      reason: 'outside sandbox',
      toolName: 'bash',
    }, abort.signal)

    expect(renderApp(transcript, interaction)).toMatchInlineSnapshot(`
      "dsh-tui · session-app · idle
      fixture/model · /fixture/workspace
      transcript empty
      ╭──────────────────────────────────────────────────╮
      │ Approval · agent root-agent                      │
      │ bash                                             │
      │ outside sandbox                                  │
      │ Y allow once · N reject                          │
      ╰──────────────────────────────────────────────────╯
      ›
      Enter send · ^S steer · ^C cancel · /exit quit"
    `)

    abort.abort(new Error('done'))
    await expect(pending).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })

  it('renders question cursor, multi-select controls, and Other affordance', async () => {
    const transcript = new TranscriptController()
    const interaction = new InteractionController()
    const abort = new AbortController()
    const pending = interaction.askQuestions({
      agent: { id: 'root-agent' } as unknown as Agent,
      questions: [{
        header: 'Scope',
        id: 'scope',
        multiSelect: true,
        options: [{ label: 'Tests' }, { description: 'Update docs', label: 'Docs' }],
        question: 'What should be included?',
      }],
    }, abort.signal)

    expect(renderApp(transcript, interaction)).toContain('> [ ] Tests')
    expect(renderApp(transcript, interaction)).toContain('Tab: Other · Enter: answer')

    abort.abort(new Error('done'))
    await expect(pending).rejects.toThrow('done')
    interaction.dispose()
    await transcript.dispose()
  })
})
