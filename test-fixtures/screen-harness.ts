/**
 * A real terminal, read as a screen.
 *
 * `renderToString` yields text. A terminal is a grid that escape sequences
 * mutate: cells get overwritten, the cursor has a position, inversion is what
 * makes a caret visible, and the alternate screen is a separate buffer. Every
 * interface defect this project shipped lived in that gap, so this drives the
 * real interface under a PTY and feeds the bytes through a terminal emulator.
 *
 * Test-only. It spawns processes and owns a PTY, so it must be disposed.
 */
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn, type IPty } from '@lydell/node-pty'
import pkg from '@xterm/headless'

const { Terminal } = pkg

export interface ScreenHarnessOptions {
  readonly columns?: number
  readonly rows?: number
  /** Scenario name passed to the fixture; decides what the transcript holds. */
  readonly scenario?: string
}

export interface Cursor {
  readonly column: number
  readonly row: number
}

const FIXTURE = resolve(import.meta.dirname, 'screen-cli.tsx')

export class ScreenHarness {
  readonly #terminal: InstanceType<typeof Terminal>
  readonly #process: IPty
  #disposed = false
  #raw = ''
  #exitCode: number | undefined

  constructor(options: ScreenHarnessOptions = {}) {
    const columns = options.columns ?? 80
    const rows = options.rows ?? 24
    this.#terminal = new Terminal({ allowProposedApi: true, cols: columns, rows })
    this.#process = spawn(
      process.execPath,
      ['--import', 'tsx', FIXTURE, options.scenario ?? 'empty'],
      {
        cols: columns,
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...process.env, CI: '', FORCE_COLOR: '3', TERM: 'xterm-256color' },
        name: 'xterm-256color',
        rows,
      },
    )
    this.#process.onData((data) => {
      // Kept alongside the emulated screen: a sequence that only changes modes
      // never lands in a cell, so the grid cannot answer whether it was sent.
      this.#raw += data
      this.#terminal.write(data)
    })
    this.#process.onExit(({ exitCode }) => {
      this.#exitCode = exitCode
    })
  }

  /** The visible grid, trailing blanks trimmed from each line. */
  screen(): string[] {
    const buffer = this.#terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
  }

  /** Where the terminal would draw a hardware caret. */
  cursor(): Cursor {
    const buffer = this.#terminal.buffer.active
    return { column: buffer.cursorX, row: buffer.cursorY }
  }

  /**
   * True when the process took the alternate screen. Read from the emulator's
   * own buffer identity rather than by scanning output for an escape, so a
   * sequence that was written and then undone cannot read as success.
   */
  onAlternateScreen(): boolean {
    return this.#terminal.buffer.active.type === 'alternate'
  }

  /**
   * Every inverted cell on screen.
   *
   * Ink hides the hardware cursor and draws its own caret, so the terminal's
   * cursor position says nothing about where the user sees one. Inversion is
   * what makes the caret visible, and it is the only thing that does.
   */
  invertedCells(): { column: number, row: number }[] {
    const buffer = this.#terminal.buffer.active
    const found: { column: number, row: number }[] = []
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(row)
      if (line === undefined) continue
      for (let column = 0; column < this.#terminal.cols; column += 1) {
        // `isInverse` answers with a bit flag, not a boolean or 1. Comparing
        // it against 1 reports every caret as missing.
        if ((line.getCell(column)?.isInverse() ?? 0) !== 0) found.push({ column, row })
      }
    }
    return found
  }

  /**
   * Cells whose background is not the terminal's default — what draws a band.
   *
   * Distinct from inversion: a band that inverts every cell is the strongest
   * signal a terminal has, and spending it on an ordinary row reads as glare.
   * The band is a raised background, so that is what has to be asserted.
   */
  bandedCells(): { column: number, row: number }[] {
    const buffer = this.#terminal.buffer.active
    const found: { column: number, row: number }[] = []
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(row)
      if (line === undefined) continue
      for (let column = 0; column < this.#terminal.cols; column += 1) {
        // `isBgDefault` answers with a boolean while `isInverse` answers with
        // a bit flag. Comparing either against a specific number is how a cell
        // attribute silently reads as absent.
        const cell = line.getCell(column)
        if (cell !== undefined && !cell.isBgDefault()) found.push({ column, row })
      }
    }
    return found
  }

  /** The character drawn in a cell, as the terminal holds it. */
  characterAt(row: number, column: number): string {
    return this.#terminal.buffer.active.getLine(row)?.getCell(column)?.getChars() ?? ''
  }

  /** A wheel notch, as a terminal reports it in SGR mode. */
  wheel(direction: 'down' | 'up', column = 1, row = 1): void {
    const button = direction === 'up' ? 64 : 65
    this.#process.write(
      `${String.fromCodePoint(0x1b)}[<${String(button)};${String(column)};${String(row)}M`,
    )
  }

  /** Every byte the process wrote, escape sequences included. */
  rawOutput(): string {
    return this.#raw
  }

  /** Waits for the process to exit on its own, rather than killing it. */
  async waitForExit(timeoutMs = 15_000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (this.#exitCode === undefined) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for exit.\nScreen was:\n${this.screen().join('\n')}`)
      }
      await delay(25)
    }
    return this.#exitCode
  }

  type(text: string): void {
    this.#process.write(text)
  }

  /** Waits until the screen satisfies `predicate`, or fails with what it saw. */
  async waitFor(
    predicate: (screen: string[]) => boolean,
    description: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate(this.screen())) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${description}.\nScreen was:\n${this.screen().join('\n')}`,
        )
      }
      await delay(25)
    }
  }

  /** Lets a repaint land after input; the renderer is capped at 20fps. */
  async settle(): Promise<void> {
    await delay(150)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#process.kill()
    this.#terminal.dispose()
  }
}
