import { describe, expect, it, vi } from 'vitest'

import { ChangeIndexController, type ChangePresentationIntent } from './change-index-controller'

function intent(
  callId: string,
  path: string,
  eventSeq: number,
  phase: ChangePresentationIntent['phase'] = 'planned',
): ChangePresentationIntent {
  return {
    callId,
    diffs: [{ newText: `new ${callId}`, oldText: `old ${callId}`, path }],
    eventSeq,
    phase,
    rowId: `tool:${callId}`,
    title: `Edit ${path}`,
  }
}

describe('ChangeIndexController', () => {
  it('groups parallel and repeated changes by file while retaining call order', () => {
    const controller = new ChangeIndexController()
    controller.record(intent('call-a', 'src/a.ts', 1))
    controller.record(intent('call-b', 'src/b.ts', 2, 'applied'))
    controller.record(intent('call-c', 'src/a.ts', 3, 'applied'))

    expect(controller.getSnapshot().groups.map(group => ({
      calls: group.changes.map(change => change.callId),
      path: group.path,
    }))).toEqual([
      { calls: ['call-a', 'call-c'], path: 'src/a.ts' },
      { calls: ['call-b'], path: 'src/b.ts' },
    ])
    expect(controller.approvalContext('call-a')).toEqual([
      'Planned changes (1):',
      '  src/a.ts',
    ])
    expect(controller.approvalContext('call-b')).toEqual([])
    expect(controller.selected()?.callId).toBe('call-a')
    controller.move('down')
    expect(controller.selected()?.callId).toBe('call-c')
    expect(controller.getSnapshot().selectedIndex).toBe(1)
    controller.move('down')
    expect(controller.selected()?.callId).toBe('call-b')
    expect(controller.getSnapshot().selectedIndex).toBe(2)
  })

  it('replaces a call-time plan with its durable result status and diff', () => {
    const controller = new ChangeIndexController()
    controller.record(intent('call-a', 'planned.ts', 1))
    controller.toggleSelected()
    controller.record(intent('call-a', 'applied.ts', 2, 'applied'))

    expect(controller.getSnapshot()).toMatchObject({
      groups: [{
        changes: [{ eventSeq: 2, expanded: false, phase: 'applied' }],
        path: 'applied.ts',
      }],
      totalChanges: 1,
    })
  })

  it('preserves planned context as unverified when a result diff is malformed', () => {
    const controller = new ChangeIndexController()
    controller.record(intent('call-a', 'planned.ts', 1))
    controller.record({
      ...intent('call-a', 'ignored.ts', 2, 'applied'),
      diffs: [null],
    } as unknown as ChangePresentationIntent)

    expect(controller.getSnapshot().groups[0]).toMatchObject({
      changes: [{ eventSeq: 2, phase: 'unverified' }],
      path: 'planned.ts',
    })
    expect(controller.approvalContext('call-a')).toEqual([])
  })

  it('supports stable selection and fold state', () => {
    const controller = new ChangeIndexController()
    controller.record(intent('call-a', 'a.ts', 1))
    controller.record(intent('call-b', 'b.ts', 2))

    expect(controller.selected()?.callId).toBe('call-a')
    expect(controller.move('down')).toBe(true)
    expect(controller.selected()?.callId).toBe('call-b')
    expect(controller.toggleSelected()).toBe(true)
    expect(controller.selected()?.expanded).toBe(true)
    expect(controller.move('down')).toBe(false)
  })

  it('ignores malformed diffs, bounds text, and reports incomplete retention', () => {
    const controller = new ChangeIndexController({
      maxChanges: 2,
      maxFiles: 2,
      maxMetadataCodeUnits: 5,
      maxTextCodeUnits: 4,
    })
    controller.record({
      ...intent('first', 'first.ts', 1),
      diffs: [
        { newText: '123456', oldText: 'abcdef', path: 'first.ts' },
        { newText: 'ok', oldText: null, path: '' },
      ],
    })
    controller.record(intent('second', 'second.ts', 2))
    controller.record(intent('third', 'third.ts', 3))

    const snapshot = controller.getSnapshot()
    expect(snapshot.groups.map(group => group.path)).toEqual(['seco…', 'thir…'])
    expect(snapshot.groups[0]?.changes[0]).toMatchObject({
      newText: 'new…',
      oldText: 'old…',
      truncated: true,
    })
    expect(snapshot).toMatchObject({
      droppedChanges: 1,
      invalidDiffs: 1,
      totalChanges: 2,
      truncated: true,
    })

    controller.record({
      ...intent('bad', 'bad.ts', 4),
      diffs: undefined,
    } as unknown as ChangePresentationIntent)
    expect(controller.getSnapshot().invalidDiffs).toBe(2)

    controller.record({
      ...intent('null', 'bad.ts', 5),
      diffs: [null],
    } as unknown as ChangePresentationIntent)
    expect(controller.getSnapshot().invalidDiffs).toBe(3)
  })

  it('notifies observers and becomes quiescent on disposal', () => {
    const controller = new ChangeIndexController()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.record(intent('call-a', 'a.ts', 1))
    expect(listener).toHaveBeenCalledTimes(1)

    controller.dispose()
    expect(() => controller.record(intent('call-b', 'b.ts', 2))).toThrow('disposed')
    expect(() => controller.subscribe(listener)).toThrow('disposed')
  })
})
