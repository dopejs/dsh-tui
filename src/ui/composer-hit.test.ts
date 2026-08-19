import { describe, expect, it } from 'vitest'

import { EditorController } from '../model/editor-controller'
import { createComposerView, offsetAtCell } from './composer'

describe('offsetAtCell (M7.8)', () => {
  it('turns a clicked cell into the offset under it', () => {
    const editor = new EditorController({ initialText: 'hello' })
    const view = createComposerView(editor.getSnapshot(), 40, 3)
    // Two cells of prompt, then the text.
    expect(offsetAtCell(view, 0, 2)).toBe(0)
    expect(offsetAtCell(view, 0, 4)).toBe(2)
    editor.dispose()
  })

  // A CJK character occupies two cells. Counting characters would land a click
  // in the middle of one and put the caret before it.
  it('measures in cells, so a click after wide characters lands after them', () => {
    const editor = new EditorController({ initialText: '你好ab' })
    const view = createComposerView(editor.getSnapshot(), 40, 3)
    expect(offsetAtCell(view, 0, 2)).toBe(0)
    expect(offsetAtCell(view, 0, 4)).toBe(1)
    expect(offsetAtCell(view, 0, 6)).toBe(2)
    editor.dispose()
  })

  // A click past the end asks for the end, which is what every editor does.
  it('clamps a click beyond the text to the end of the line', () => {
    const editor = new EditorController({ initialText: 'abc' })
    const view = createComposerView(editor.getSnapshot(), 40, 3)
    expect(offsetAtCell(view, 0, 99)).toBe(3)
    editor.dispose()
  })

  it('reports nothing for a row the composer does not draw', () => {
    const editor = new EditorController({ initialText: 'abc' })
    const view = createComposerView(editor.getSnapshot(), 40, 3)
    expect(offsetAtCell(view, 5, 2)).toBeUndefined()
    editor.dispose()
  })
})
