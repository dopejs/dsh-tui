import { bench, describe } from 'vitest'

import { EditorController } from '../src/model/editor-controller'
import { createComposerView } from '../src/ui/composer'

const largeText = `${'0123456789'.repeat(9_999)}👩🏽‍💻寬字`

describe('100,000-code-unit bounded editor', () => {
  bench('single insertion and undo near the end', () => {
    const editor = new EditorController({ initialText: largeText })
    editor.move('left')
    editor.insert('x')
    editor.undo()
    editor.dispose()
  })

  bench('80-column composer viewport projection', () => {
    const editor = new EditorController({ initialText: largeText })
    editor.move('left')
    createComposerView(editor.getSnapshot(), 78, 6)
    editor.dispose()
  })
})
