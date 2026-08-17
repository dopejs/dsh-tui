import { renderToString } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { EditorController } from '../model/editor-controller'

/** Widest rendered line: a multi-line frame must fit the terminal per row. */
function widestLine(output: string): number {
  return Math.max(...output.split('\n').map(line => stringWidth(line)))
}
import { Composer, createComposerView } from './composer'

describe('Composer (M1.1)', () => {
  it('renders an explicit cursor in an empty multiline editor', () => {
    const editor = new EditorController()

    expect(renderToString(
      <Composer columns={40} maxRows={5} snapshot={editor.getSnapshot()} />,
      { columns: 40 },
    )).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────╮
      │ › █                                  │
      ╰──────────────────────────────────────╯"
    `)

    editor.dispose()
  })

  it('keeps the cursor line visible and reports bounded logical lines', () => {
    const editor = new EditorController({ initialText: 'one\ntwo\nthree\nfour\nfive\nsix' })
    editor.move('line-start')

    const view = createComposerView(editor.getSnapshot(), 30, 3)
    expect(view).toMatchObject({
      cursorLine: 5,
      hiddenAbove: 3,
      hiddenBelow: 0,
      totalLines: 6,
    })
    expect(renderToString(
      <Composer columns={32} maxRows={3} snapshot={editor.getSnapshot()} />,
      { columns: 32 },
    )).toMatchInlineSnapshot(`
      "╭──────────────────────────────╮
      │ │ four                       │
      │ │ five                       │
      │ › six                        │
      │ ↑3                           │
      ╰──────────────────────────────╯"
    `)

    editor.dispose()
  })

  it('crops a long line around the cursor using terminal cell width', () => {
    const editor = new EditorController({ initialText: '0123456789寬字abcdefghij' })
    editor.move('left')
    editor.move('left')
    editor.move('left')

    const output = renderToString(
      <Composer columns={12} maxRows={2} snapshot={editor.getSnapshot()} />,
      { columns: 12 },
    )
    expect(output).toContain('…')
    expect(output).toContain('hij')
    expect(widestLine(output)).toBeLessThanOrEqual(12)

    editor.dispose()
  })

  it('renders selected Unicode text and cursor without changing the model', () => {
    const editor = new EditorController({ initialText: 'A寬🙂B' })
    editor.move('left')
    editor.move('left', true)
    const before = editor.getSnapshot()

    expect(renderToString(
      <Composer columns={20} maxRows={2} snapshot={before} />,
      { columns: 20 },
    )).toContain('A寬🙂B')
    expect(editor.getSnapshot()).toBe(before)

    editor.dispose()
  })

  it('keeps a cursor visible before a standalone zero-width mark', () => {
    const editor = new EditorController({ initialText: '\u0301' })
    editor.move('document-start')
    expect(renderToString(
      <Composer columns={10} maxRows={1} snapshot={editor.getSnapshot()} />,
      { columns: 10 },
    )).toContain('█')
    editor.dispose()
  })

  it('validates fixed viewport inputs', () => {
    const editor = new EditorController()
    expect(() => createComposerView(editor.getSnapshot(), 0, 1)).toThrow('columns')
    expect(() => createComposerView(editor.getSnapshot(), 1, 0)).toThrow('maxRows')
    editor.dispose()
  })

  // A hint that survived one keystroke would read as text about to be sent.
  it('shows the placeholder only while the draft is empty', () => {
    const empty = new EditorController()
    const withPlaceholder = renderToString(
      <Composer columns={60} maxRows={3} placeholder="Try something" snapshot={empty.getSnapshot()} />,
      { columns: 60 },
    )
    expect(withPlaceholder).toContain('Try something')

    empty.insert('h')
    const typed = renderToString(
      <Composer columns={60} maxRows={3} placeholder="Try something" snapshot={empty.getSnapshot()} />,
      { columns: 60 },
    )
    expect(typed).not.toContain('Try something')
    expect(typed).toContain('h')
  })

  it('omits the placeholder when none is given', () => {
    const empty = new EditorController()
    const output = renderToString(
      <Composer columns={60} maxRows={3} snapshot={empty.getSnapshot()} />,
      { columns: 60 },
    )
    expect(output).not.toContain('Try')
  })

  it('drops the frame in screen-reader mode', () => {
    const empty = new EditorController()
    const plain = renderToString(
      <Composer columns={60} maxRows={3} screenReader snapshot={empty.getSnapshot()} />,
      { columns: 60 },
    )
    expect(plain).not.toMatch(/[\u2500-\u257F]/)
  })
})

