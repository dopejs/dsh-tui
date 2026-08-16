import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'

import { SubagentTreeController } from './subagent-tree-controller'

const SID = (value: string): SessionId => value as unknown as SessionId

function fakeAgent(id: string): Agent {
  return { id: SID(id) } as unknown as Agent
}

function child(
  id: string,
  overrides: Partial<SubagentDescendantListEntry> = {},
): SubagentDescendantListEntry {
  return {
    activity: 'running',
    depth: 1,
    hasChildren: false,
    id: SID(id),
    kind: 'child',
    label: `child ${id}`,
    mode: 'continuable',
    parentId: SID('root'),
    ...overrides,
  } as SubagentDescendantListEntry
}

function diagnostic(id: string, reason: 'corrupt' | 'unavailable'): SubagentDescendantListEntry {
  return {
    depth: 1,
    id: SID(id),
    kind: 'diagnostic',
    parentId: SID('root'),
    reason,
  } as SubagentDescendantListEntry
}

class FakeSubagentRuntime {
  readonly followup = vi.fn(async () => 'message-1' as never)
  readonly interrupt = vi.fn<(target: SessionId, authority: unknown) => void>()
  readonly listDescendants = vi.fn<
    (root: SessionId, signal?: AbortSignal) => Promise<SubagentDescendantListEntry[]>
  >(async () => [])
}

describe('SubagentTreeController (M3.3)', () => {
  it('is unavailable without the runtime and exposes no controls', async () => {
    const controller = new SubagentTreeController(fakeAgent('root'))
    expect(controller.getSnapshot()).toMatchObject({
      rootSessionId: 'root',
      rows: [],
      status: 'unavailable',
      unreadCount: 0,
    })
    await expect(controller.refresh()).resolves.toBe(false)
    expect(controller.interrupt()).toBe(false)
    expect(controller.attach()).toBe(false)
    await expect(controller.followup('hi')).resolves.toBe('refused')
    controller.dispose()
  })

  it('projects a stable pre-order tree with lineage, depth, and diagnostics', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([
      child('a'),
      child('a1', { depth: 2, mode: 'one-shot', parentId: SID('a') }),
      diagnostic('bad', 'corrupt'),
    ])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()

    const snapshot = controller.getSnapshot()
    expect(runtime.listDescendants).toHaveBeenCalledWith(SID('root'), expect.any(AbortSignal))
    expect(snapshot.status).toBe('ready')
    expect(snapshot.rows.map(row => [row.id, row.depth, row.kind])).toEqual([
      ['a', 1, 'child'],
      ['a1', 2, 'child'],
      ['bad', 1, 'diagnostic'],
    ])
    expect(snapshot.rows[1]).toMatchObject({ mode: 'one-shot', parentId: 'a' })
    expect(snapshot.rows[2]).toMatchObject({ reason: 'corrupt' })
    controller.dispose()
  })

  it('marks new and changed children unread and clears them on acknowledge', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('a'), child('b')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()
    expect(controller.getSnapshot().unreadCount).toBe(2)

    controller.acknowledge()
    expect(controller.getSnapshot().unreadCount).toBe(0)

    // An unchanged re-listing must not resurrect unread state.
    await controller.refresh()
    expect(controller.getSnapshot().unreadCount).toBe(0)

    // A status change is what makes a row unread again.
    runtime.listDescendants.mockResolvedValue([child('a', { activity: 'inactive' }), child('b')])
    await controller.refresh()
    expect(controller.getSnapshot().unreadCount).toBe(1)
    expect(controller.getSnapshot().rows[0]?.unread).toBe(true)
    controller.dispose()
  })

  it('keeps selection on its session id when parallel children appear and disappear', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('a'), child('b'), child('c')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()
    controller.move('down')
    controller.move('down')
    expect(controller.selected()?.id).toBe('c')

    runtime.listDescendants.mockResolvedValue([child('new'), child('a'), child('b'), child('c')])
    await controller.refresh()
    expect(controller.selected()?.id).toBe('c')

    // A disappearing agent falls back to the first row rather than a stale index.
    runtime.listDescendants.mockResolvedValue([child('a')])
    await controller.refresh()
    expect(controller.selected()?.id).toBe('a')
    controller.dispose()
  })

  it('discards a stale listing that resolves after a newer one', async () => {
    const runtime = new FakeSubagentRuntime()
    let releaseSlow: (entries: SubagentDescendantListEntry[]) => void = () => undefined
    runtime.listDescendants.mockImplementationOnce(async () => new Promise((resolve) => {
      releaseSlow = resolve
    }))
    runtime.listDescendants.mockImplementationOnce(async () => [child('fresh')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)

    const slow = controller.refresh()
    const fresh = controller.refresh()
    await fresh
    expect(controller.getSnapshot().rows.map(row => row.id)).toEqual(['fresh'])

    releaseSlow([child('stale')])
    await expect(slow).resolves.toBe(false)
    expect(controller.getSnapshot().rows.map(row => row.id)).toEqual(['fresh'])
    controller.dispose()
  })

  it('abandons pending work and unread state on a root switch', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('a')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()
    expect(controller.getSnapshot().unreadCount).toBe(1)

    expect(controller.setRoot(SID('other'))).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      rootSessionId: 'other',
      rows: [],
      unreadCount: 0,
    })
    expect(controller.setRoot(SID('other'))).toBe(false)

    runtime.listDescendants.mockResolvedValue([child('a')])
    await controller.refresh()
    expect(runtime.listDescendants).toHaveBeenLastCalledWith(SID('other'), expect.any(AbortSignal))
    // The tree is different, so the same id is legitimately unread again.
    expect(controller.getSnapshot().unreadCount).toBe(1)
    controller.dispose()
  })

  it('interrupts only a live continuable child, under this session as human parent', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([
      child('live'),
      child('cold', { activity: 'inactive' }),
      child('one-shot', { mode: 'one-shot' }),
      diagnostic('bad', 'corrupt'),
    ])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()

    expect(controller.interrupt()).toBe(true)
    expect(runtime.interrupt).toHaveBeenCalledWith(SID('live'), {
      kind: 'user',
      parentSessionId: SID('root'),
    })

    controller.move('down')
    expect(controller.interrupt()).toBe(false) // inactive
    controller.move('down')
    expect(controller.interrupt()).toBe(false) // one-shot
    controller.move('down')
    expect(controller.interrupt()).toBe(false) // diagnostic
    expect(runtime.interrupt).toHaveBeenCalledOnce()
    controller.dispose()
  })

  // `followup` requires the exact live direct parent, which this session is only at depth 1.
  it('refuses follow-up for anything but its own direct continuable children', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([
      child('direct'),
      child('grandchild', { depth: 2, parentId: SID('direct') }),
      child('one-shot', { mode: 'one-shot' }),
    ])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()

    expect(controller.canFollowup()).toBe(true)
    await expect(controller.followup('keep going')).resolves.toBe('delivered')
    expect(runtime.followup).toHaveBeenCalledWith(
      expect.objectContaining({ id: SID('root') }),
      SID('direct'),
      [{ text: 'keep going', type: 'text' }],
      expect.objectContaining({ source: { kind: 'user' } }),
    )

    controller.move('down')
    expect(controller.canFollowup()).toBe(false)
    await expect(controller.followup('deeper')).resolves.toBe('refused')
    controller.move('down')
    await expect(controller.followup('one-shot')).resolves.toBe('refused')
    expect(runtime.followup).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('keeps a follow-up draft addressed to the child it was armed against', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('a'), child('b')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()

    expect(controller.beginFollowup()).toBe(true)
    controller.setFollowupText('finish the audit')
    expect(controller.getSnapshot()).toMatchObject({
      followupText: 'finish the audit',
      status: 'followup-input',
    })

    // Moving the cursor must not redirect an armed draft.
    controller.move('down')
    expect(controller.selected()?.id).toBe('b')
    await expect(controller.followup()).resolves.toBe('delivered')
    expect(runtime.followup).toHaveBeenCalledWith(
      expect.anything(),
      SID('a'),
      [{ text: 'finish the audit', type: 'text' }],
      expect.anything(),
    )
    expect(controller.getSnapshot()).toMatchObject({ followupText: '', status: 'ready' })
    controller.dispose()
  })

  it('drops a follow-up draft when its child leaves the tree or the root changes', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('a')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()
    controller.beginFollowup()
    controller.setFollowupText('still there?')

    runtime.listDescendants.mockResolvedValue([child('b')])
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ followupText: '', status: 'ready' })

    controller.beginFollowup()
    controller.setFollowupText('draft')
    controller.setRoot(SID('other'))
    expect(controller.getSnapshot().followupText).toBe('')
    expect(controller.cancelFollowup()).toBe(false)
    controller.dispose()
  })

  it('refuses empty follow-up text', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('direct')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    await controller.refresh()
    await expect(controller.followup('   ')).resolves.toBe('refused')
    expect(runtime.followup).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('reports a failed delivery without claiming the message landed', async () => {
    const reportError = vi.fn()
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('direct')])
    runtime.followup.mockRejectedValue(new Error('parent authority rejected') as never)
    const controller = new SubagentTreeController(fakeAgent('root'), runtime, { reportError })
    await controller.refresh()

    await expect(controller.followup('hello')).resolves.toBe('failed')
    expect(controller.getSnapshot()).toMatchObject({
      error: 'parent authority rejected',
      status: 'error',
    })
    expect(reportError).toHaveBeenCalled()
    controller.dispose()
  })

  it('surfaces a failed listing and recovers on the next one', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockRejectedValueOnce(new Error('projection registry not mounted'))
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)

    await expect(controller.refresh()).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      error: 'projection registry not mounted',
      status: 'error',
    })

    runtime.listDescendants.mockResolvedValue([child('a')])
    await expect(controller.refresh()).resolves.toBe(true)
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('delegates attachment by session id and never resumes an agent itself', async () => {
    const attach = vi.fn()
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue([child('a'), diagnostic('bad', 'unavailable')])
    const controller = new SubagentTreeController(fakeAgent('root'), runtime, { attach })
    await controller.refresh()

    expect(controller.attach()).toBe(true)
    expect(attach).toHaveBeenCalledWith(SID('a'))

    controller.move('down')
    expect(controller.attach()).toBe(false) // a diagnostic row has no session to attach
    expect(attach).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('bounds the tree and reports truncation', async () => {
    const runtime = new FakeSubagentRuntime()
    runtime.listDescendants.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => child(`c${String(index)}`)),
    )
    const controller = new SubagentTreeController(fakeAgent('root'), runtime, { maxRows: 4 })
    await controller.refresh()
    expect(controller.getSnapshot().truncated).toBe(true)
    expect(controller.getSnapshot().rows).toHaveLength(4)
    controller.dispose()
  })

  it('rejects invalid bounds', () => {
    expect(() => new SubagentTreeController(fakeAgent('root'), undefined, { maxRows: 0 }))
      .toThrow('maxRows must be a positive safe integer')
  })

  it('aborts pending enumeration on disposal and never updates afterwards', async () => {
    const runtime = new FakeSubagentRuntime()
    let observed: AbortSignal | undefined
    // A compliant runtime observes the signal and rejects with CANCELLED.
    runtime.listDescendants.mockImplementation(async (_root, signal) => {
      observed = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('CANCELLED')))
      })
    })
    const controller = new SubagentTreeController(fakeAgent('root'), runtime)
    const listener = vi.fn()
    controller.subscribe(listener)
    const pending = controller.refresh()

    controller.dispose()

    expect(observed?.aborted).toBe(true)
    await expect(pending).resolves.toBe(false)
    await expect(controller.refresh()).rejects.toThrow('SubagentTreeController is disposed')
    expect(() => controller.move('down')).toThrow('SubagentTreeController is disposed')
    controller.dispose()
  })
})
