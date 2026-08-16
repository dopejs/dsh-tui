import { describe, expect, it, vi } from 'vitest'

import { EditorController } from './editor-controller'

describe('EditorController (M1.1)', () => {
  it('inserts, replaces a selection, and never splits surrogate pairs or emoji sequences', () => {
    const editor = new EditorController({ initialText: 'A👩🏽‍💻B' })

    expect(editor.move('left')).toBe(true)
    expect(editor.getSnapshot().cursor).toBe(8)
    expect(editor.move('left')).toBe(true)
    expect(editor.getSnapshot().cursor).toBe(1)
    expect(editor.move('right', true)).toBe(true)
    expect(editor.getSnapshot()).toMatchObject({ anchor: 1, cursor: 8 })
    expect(editor.insert('🙂')).toBe('applied')
    expect(editor.getSnapshot()).toMatchObject({ cursor: 3, text: 'A🙂B' })

    editor.dispose()
  })

  it('supports multiline vertical movement with a preserved preferred column', () => {
    const editor = new EditorController({ initialText: 'abcd\nx\n12345' })

    editor.move('line-start')
    editor.move('right')
    editor.move('right')
    editor.move('right')
    expect(editor.getSnapshot().cursor).toBe(10)
    editor.move('up')
    expect(editor.getSnapshot().cursor).toBe(6)
    editor.move('up')
    expect(editor.getSnapshot().cursor).toBe(3)
    editor.move('down')
    editor.move('down')
    expect(editor.getSnapshot().cursor).toBe(10)

    editor.dispose()
  })

  it('keeps document-start movement valid when the first line is empty', () => {
    const editor = new EditorController({ initialText: '\nabc' })
    editor.move('document-start')
    expect(editor.move('line-start')).toBe(false)
    expect(editor.getSnapshot().cursor).toBe(0)
    editor.move('down')
    expect(editor.getSnapshot().cursor).toBe(1)
    editor.move('up')
    expect(editor.getSnapshot().cursor).toBe(0)
    editor.dispose()
  })

  it('moves by words, lines, and document boundaries', () => {
    const editor = new EditorController({ initialText: 'one two\nthree' })

    editor.move('document-start')
    editor.move('word-right')
    expect(editor.getSnapshot().cursor).toBe(3)
    editor.move('word-right')
    expect(editor.getSnapshot().cursor).toBe(7)
    editor.move('line-start')
    expect(editor.getSnapshot().cursor).toBe(0)
    editor.move('line-end')
    expect(editor.getSnapshot().cursor).toBe(7)
    editor.move('document-end')
    expect(editor.getSnapshot().cursor).toBe(13)
    editor.move('word-left')
    expect(editor.getSnapshot().cursor).toBe(8)

    editor.dispose()
  })

  it('supports selection collapse, select all, forward delete, and backspace', () => {
    const editor = new EditorController({ initialText: 'abc' })

    editor.move('left', true)
    expect(editor.getSnapshot().anchor).toBe(3)
    editor.move('left')
    expect(editor.getSnapshot()).toMatchObject({ cursor: 2, text: 'abc' })
    expect(editor.getSnapshot().anchor).toBeUndefined()
    expect(editor.deleteForward()).toBe('applied')
    expect(editor.getSnapshot().text).toBe('ab')
    expect(editor.backspace()).toBe('applied')
    expect(editor.getSnapshot().text).toBe('a')
    editor.selectAll()
    expect(editor.insert('x')).toBe('applied')
    expect(editor.getSnapshot()).toMatchObject({ cursor: 1, text: 'x' })

    editor.dispose()
  })

  it('supports bounded undo and redo without retaining an unbounded edit log', () => {
    const editor = new EditorController({ undoLimit: 2 })

    editor.insert('a')
    editor.insert('b')
    editor.insert('c')
    expect(editor.getSnapshot()).toMatchObject({ canRedo: false, canUndo: true, text: 'abc' })
    expect(editor.undo()).toBe(true)
    expect(editor.getSnapshot().text).toBe('ab')
    expect(editor.undo()).toBe(true)
    expect(editor.getSnapshot().text).toBe('a')
    expect(editor.undo()).toBe(false)
    expect(editor.redo()).toBe(true)
    expect(editor.getSnapshot().text).toBe('ab')
    editor.insert('!')
    expect(editor.redo()).toBe(false)

    editor.dispose()
  })

  it('kills, yanks, and deletes a word as explicit editor operations', () => {
    const editor = new EditorController({ initialText: 'alpha beta\ngamma' })

    editor.move('document-start')
    editor.move('word-right')
    expect(editor.killToLineEnd()).toBe('applied')
    expect(editor.getSnapshot().text).toBe('alpha\ngamma')
    editor.move('document-end')
    expect(editor.yank()).toBe('applied')
    expect(editor.getSnapshot().text).toBe('alpha\ngamma beta')
    expect(editor.deleteWordBackward()).toBe('applied')
    expect(editor.getSnapshot().text).toBe('alpha\ngamma ')

    editor.dispose()
  })

  it('rejects an oversized paste atomically', () => {
    const editor = new EditorController({ initialText: '1234', textLimit: 5 })

    expect(editor.insert('ab')).toBe('limit-exceeded')
    expect(editor.getSnapshot()).toMatchObject({ cursor: 4, text: '1234' })
    editor.move('left', true)
    expect(editor.insert('ab')).toBe('applied')
    expect(editor.getSnapshot().text).toBe('123ab')

    editor.dispose()
  })

  it('applies bounded completion replacements without splitting Unicode characters', () => {
    const editor = new EditorController({ initialText: 'run @src/old tail', textLimit: 30 })

    expect(editor.replaceRange(5, 12, 'src/new.ts')).toBe('applied')
    expect(editor.getSnapshot()).toMatchObject({
      cursor: 15,
      text: 'run @src/new.ts tail',
    })
    expect(editor.undo()).toBe(true)
    expect(() => editor.replaceRange(-1, 1, 'x')).toThrow('replacement range')

    const unicode = new EditorController({ initialText: 'A👩🏽‍💻B' })
    expect(() => unicode.replaceRange(2, 8, 'x')).toThrow('Unicode character')
    expect(unicode.replaceRange(1, 8, '🙂')).toBe('applied')
    expect(unicode.getSnapshot().text).toBe('A🙂B')

    editor.dispose()
    unicode.dispose()
  })

  it('preserves a newer draft when an older asynchronous submission is accepted', () => {
    const editor = new EditorController()
    editor.insert('first')
    const submitted = editor.captureSubmission()
    editor.insert(' and newer')

    expect(editor.acceptSubmission(submitted)).toBe(false)
    expect(editor.getSnapshot().text).toBe('first and newer')
    expect(editor.searchHistory('FIRST')).toEqual({ index: 0, text: 'first' })

    editor.dispose()
  })

  it('does not invalidate a newer submission when an older one records history later', () => {
    const editor = new EditorController()
    editor.insert('first')
    const first = editor.captureSubmission()
    editor.clear()
    editor.insert('second')
    const second = editor.captureSubmission()

    expect(editor.acceptSubmission(first)).toBe(false)
    expect(editor.getSnapshot().text).toBe('second')
    expect(editor.acceptSubmission(second)).toBe(true)
    expect(editor.getSnapshot()).toMatchObject({ historySize: 2, text: '' })

    editor.dispose()
  })

  it('clears only the exact accepted draft and resets its edit transaction', () => {
    const editor = new EditorController()
    editor.insert('ship it')
    const submitted = editor.captureSubmission()

    expect(editor.acceptSubmission(submitted)).toBe(true)
    expect(editor.getSnapshot()).toMatchObject({
      canRedo: false,
      canUndo: false,
      cursor: 0,
      historySize: 1,
      text: '',
    })
    expect(editor.undo()).toBe(false)

    editor.dispose()
  })

  it('traverses bounded history while restoring the unfinished draft', () => {
    const editor = new EditorController({ historyLimit: 2 })
    for (const text of ['one', 'two', 'three']) {
      editor.insert(text)
      editor.acceptSubmission(editor.captureSubmission())
    }
    editor.insert('draft')

    expect(editor.previousHistory()).toBe(true)
    expect(editor.getSnapshot().text).toBe('three')
    expect(editor.previousHistory()).toBe(true)
    expect(editor.getSnapshot().text).toBe('two')
    expect(editor.previousHistory()).toBe(false)
    expect(editor.nextHistory()).toBe(true)
    expect(editor.getSnapshot().text).toBe('three')
    expect(editor.nextHistory()).toBe(true)
    expect(editor.getSnapshot().text).toBe('draft')
    expect(editor.getSnapshot().historyIndex).toBeUndefined()

    editor.dispose()
  })

  it('bounds retained undo and history text by aggregate code units', () => {
    const editor = new EditorController({
      historyCodeUnitLimit: 7,
      historyLimit: 20,
      undoCodeUnitLimit: 3,
      undoLimit: 20,
    })
    for (const text of ['aaaa', 'bbbb', 'cc']) {
      editor.insert(text)
      editor.acceptSubmission(editor.captureSubmission())
    }
    expect(editor.getSnapshot().historySize).toBe(2)
    expect(editor.searchHistory('aaaa')).toBeUndefined()

    editor.insert('a')
    editor.insert('b')
    editor.insert('c')
    editor.insert('d')
    let undoCount = 0
    while (editor.undo()) undoCount += 1
    expect(undoCount).toBeLessThan(4)

    editor.dispose()
  })

  it('searches history backwards and validates a selected match', () => {
    const editor = new EditorController({ history: ['pnpm test', 'git status', 'pnpm check'] })

    expect(editor.searchHistory('PNPM')).toEqual({ index: 2, text: 'pnpm check' })
    expect(editor.searchHistory('pnpm', 2)).toEqual({ index: 0, text: 'pnpm test' })
    expect(editor.useHistoryMatch({ index: 1, text: 'wrong' })).toBe(false)
    expect(editor.useHistoryMatch({ index: 1, text: 'git status' })).toBe(true)
    expect(editor.getSnapshot().text).toBe('git status')

    editor.dispose()
  })

  it('publishes stable snapshots and becomes quiescent on disposal', () => {
    const editor = new EditorController()
    const listener = vi.fn()
    const unsubscribe = editor.subscribe(listener)
    const initial = editor.getSnapshot()

    expect(editor.insert('x')).toBe('applied')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(editor.getSnapshot()).not.toBe(initial)
    expect(editor.getSnapshot()).toBe(editor.getSnapshot())
    unsubscribe()
    editor.insert('y')
    expect(listener).toHaveBeenCalledTimes(1)

    editor.dispose()
    editor.dispose()
    expect(() => editor.insert('z')).toThrow('disposed')
  })

  it('validates resource limits and initial text', () => {
    expect(() => new EditorController({ historyLimit: 0 })).toThrow('historyLimit')
    expect(() => new EditorController({ historyCodeUnitLimit: 0 })).toThrow('historyCodeUnitLimit')
    expect(() => new EditorController({ textLimit: 2, initialText: 'abc' })).toThrow('initialText')
    expect(() => new EditorController({ undoLimit: Number.POSITIVE_INFINITY })).toThrow('undoLimit')
    expect(() => new EditorController({ undoCodeUnitLimit: 0 })).toThrow('undoCodeUnitLimit')
  })
})
