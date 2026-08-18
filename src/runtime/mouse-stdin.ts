/**
 * Splitting mouse reports out of the input stream.
 *
 * Ink reads stdin itself and has no mouse API, so a terminal asked to report
 * mouse activity sends Ink escape sequences it can only interpret as typing:
 * clicking would put `[<0;12;5M` in the composer. Filtering after the fact is
 * not possible -- Ink's listener is attached to the same stream and sees the
 * bytes first -- so Ink is handed a different stream, one this owns.
 *
 * The proxy delegates every control operation to the real stdin, because raw
 * mode, TTY identity and reference counting all belong to the real descriptor.
 * Only the data is ours to filter.
 */
import { Transform } from 'node:stream'

import { parseMouse, type MouseEvent } from './mouse'

export type MouseListener = (event: MouseEvent) => void

export interface MouseFilteredStdin {
  /**
   * Stop feeding the filter, leaving the stream Ink holds open.
   *
   * Separate from `dispose` because ending that stream while the renderer is
   * still mounted is what a renderer notices: it is reading it.
   */
  readonly detach: () => void
  /** Close the filter. Safe only once the renderer is gone. */
  readonly dispose: () => void
  /** Subscribe to decoded mouse events; returns an unsubscribe. */
  readonly onMouse: (listener: MouseListener) => () => void
  /** The stream to hand to Ink, carrying everything except mouse reports. */
  readonly stream: NodeJS.ReadStream
}

/**
 * A report can be split across two reads, so a fragment that may still become
 * one is held back rather than passed on as text. The buffer is bounded: a
 * fragment that never completes is not a mouse report, and holding it forever
 * would swallow whatever the user typed after it.
 */
const MAX_PENDING = 32

function looksUnfinished(text: string): boolean {
  const start = text.lastIndexOf('[<')
  if (start === -1) return false
  return !/[Mm]/.test(text.slice(start))
}

export function filterMouseFromStdin(source: NodeJS.ReadStream): MouseFilteredStdin {
  const listeners = new Set<MouseListener>()
  let pending = ''
  let disposed = false

  /*
   * A pipe, not a `data` listener.
   *
   * Attaching a listener assumes the stream is flowing and reaches this
   * process first. Neither is guaranteed -- a paused or already-piped stdin
   * delivers nothing -- and when that happened the interface received no
   * keystrokes at all and could not even be exited. Piping lets Node handle
   * flow control, which is the part that was being assumed.
   */
  const filter = new Transform({
    transform(chunk, _encoding, done) {
      if (disposed) {
        done()
        return
      }
      const parsed = parseMouse(pending + String(chunk))
      for (const event of parsed.events) {
        for (const listener of listeners) listener(event)
      }
      if (looksUnfinished(parsed.rest) && parsed.rest.length <= MAX_PENDING) {
        pending = parsed.rest
        done()
        return
      }
      pending = ''
      done(null, parsed.rest === '' ? undefined : parsed.rest)
    },
  })

  source.pipe(filter)

  // Ink needs a TTY it can put into raw mode. Those operations belong to the
  // real descriptor; only the bytes are rewritten here.
  const stream = new Proxy(filter as unknown as NodeJS.ReadStream, {
    get(target, property, receiver) {
      if (property === 'isTTY') return source.isTTY
      if (property === 'setRawMode') {
        return (mode: boolean) => {
          source.setRawMode?.(mode)
          return receiver as NodeJS.ReadStream
        }
      }
      if (property === 'ref' || property === 'unref') {
        return () => receiver as NodeJS.ReadStream
      }
      // Flow control reaches the real descriptor too. Ink believes it owns
      // stdin, so when it pauses on unmount it must actually pause stdin --
      // pausing only this filter leaves the real one flowing and its handle
      // open, which on Linux kept the process alive after the interface was
      // gone. macOS exited anyway, so only CI saw it.
      if (property === 'pause' || property === 'resume') {
        return () => {
          if (property === 'pause') source.pause()
          else source.resume()
          ;(target[property] as () => unknown).call(target)
          return receiver as NodeJS.ReadStream
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value
    },
  })

  let detached = false
  const detach = () => {
    if (detached) return
    detached = true
    source.unpipe(filter)
    source.pause()
    listeners.clear()
  }

  return Object.freeze({
    detach,
    dispose: () => {
      if (disposed) return
      disposed = true
      detach()
      filter.end()
    },
    onMouse: (listener: MouseListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stream,
  })
}
