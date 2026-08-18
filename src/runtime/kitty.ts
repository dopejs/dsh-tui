/**
 * Kitty keyboard protocol capability.
 *
 * Terminals report Enter and Shift-Enter as the same byte, so the two cannot be
 * told apart and one of them has to be given up. This protocol distinguishes
 * them, and Ghostty, Kitty and WezTerm all speak it.
 *
 * Ink can negotiate this itself, and its negotiation has a cost: it buffers
 * stdin for up to 200ms waiting for a reply, then pushes what it buffered back
 * into the input pipeline. The application is already listening by then, so
 * anything typed in that window arrives twice -- `hello` becomes `hellohello`.
 * Terminals that answer close the window in a millisecond; terminals that stay
 * silent leave it open for the full 200ms.
 *
 * So the query is asked here instead, before the interface is mounted and
 * before anything is listening for keystrokes, and Ink is then told the answer
 * rather than asked to find it.
 */

/** Ask the terminal which keyboard protocol flags it supports. */
export const KITTY_QUERY = '\u001b[?u'

// ESC [ ? <flags> u -- the only shape a reply takes.
// eslint-disable-next-line no-control-regex -- matching ESC is the whole point
const KITTY_REPLY = /\u001b\[\?(\d+)u/u

export interface KittyReplyParse {
  /** Input with the reply removed, so it cannot be read as typing. */
  readonly rest: string
  readonly supported: boolean
}

/**
 * Split a capability reply out of terminal input.
 *
 * A reply that reached the composer would be typed into the user's next
 * message, so it is removed whether or not anyone is waiting for it.
 */
export function parseKittyReply(input: string): KittyReplyParse {
  const match = KITTY_REPLY.exec(input)
  if (match === null) return Object.freeze({ rest: input, supported: false })
  return Object.freeze({
    rest: input.slice(0, match.index) + input.slice(match.index + match[0].length),
    supported: true,
  })
}

export interface KittyProbe {
  /** Subscribe to raw terminal input; returns an unsubscribe. */
  readonly onData: (listener: (chunk: string) => void) => () => void
  readonly write: (text: string) => void
  /** How long to wait before concluding the terminal does not speak it. */
  readonly timeoutMs?: number
}

/**
 * Whether the terminal speaks the protocol.
 *
 * Resolves `false` on silence, which is what a terminal that does not support
 * it does -- there is no negative reply to wait for.
 */
export async function probeKittySupport(probe: KittyProbe): Promise<boolean> {
  const timeoutMs = probe.timeoutMs ?? 150
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (supported: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      resolve(supported)
    }
    // Accumulated, not examined chunk by chunk: a terminal is free to split
    // its answer across reads, and a reply seen half at a time is a reply
    // never recognised -- the protocol then stays off and Shift-Enter remains
    // indistinguishable from Enter, silently.
    let buffered = ''
    const stop = probe.onData((chunk) => {
      buffered += chunk
      if (parseKittyReply(buffered).supported) finish(true)
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
    probe.write(KITTY_QUERY)
  })
}
