import terminalKit from 'terminal-kit'

import type { ScreenModel } from '../src/model/view-model'

function putLine(
  buffer: terminalKit.ScreenBuffer,
  content: string,
  y: number,
  attributes: terminalKit.ScreenBuffer.Attributes = {},
): void {
  buffer.put(
    { attr: attributes, dx: 1, dy: 0, wrap: false, x: 0, y },
    '%s',
    content,
  )
}

export function renderTerminalKitFrame(
  frame: ScreenModel,
  columns: number,
  terminalRows: number,
): string {
  const buffer = new terminalKit.ScreenBuffer({
    dst: undefined as never,
    height: terminalRows,
    width: columns,
  })
  putLine(buffer, `dsh-tui · ${frame.sessionId} · ${frame.status}`, 0, { bold: true })
  putLine(
    buffer,
    frame.visibleRange === undefined
      ? 'transcript empty'
      : `transcript ${frame.visibleRange.start}–${frame.visibleRange.end} of ${frame.totalRows}`,
    1,
  )
  frame.rows.forEach((row, index) => {
    putLine(buffer, `${row.kind[0]?.toUpperCase() ?? '!'} ${row.content}`, index + 2)
  })
  if (frame.modal !== undefined) {
    const y = terminalRows - 3
    putLine(buffer, `╭─ ${frame.modal.title} · agent ${frame.modal.agentLabel}`, y, {
      bold: true,
    })
    putLine(buffer, `│ ${frame.modal.message}`, y + 1)
    putLine(buffer, '╰─', y + 2)
  }
  return buffer.dumpChars()
}
