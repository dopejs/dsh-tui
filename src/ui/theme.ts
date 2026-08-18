import type { TuiTheme } from '../model/preferences-controller'

/**
 * Semantic roles the interface renders. Panels name the meaning, never a color,
 * so a theme — including the no-color one an accessibility mode or a
 * non-conforming terminal needs — can answer for all of them in one place.
 */
export type SemanticTone =
  | 'accent'
  | 'danger'
  | 'muted'
  | 'neutral'
  | 'positive'
  | 'warning'

/** The subset of Ink `Text` styling a tone may set. */
export interface ToneStyle {
  readonly color?: string
  readonly dimColor?: boolean
}

const DEFAULT_TONES: Readonly<Record<SemanticTone, ToneStyle>> = Object.freeze({
  accent: Object.freeze({ color: 'cyan' }),
  danger: Object.freeze({ color: 'red' }),
  muted: Object.freeze({ dimColor: true }),
  neutral: Object.freeze({}),
  positive: Object.freeze({ color: 'green' }),
  warning: Object.freeze({ color: 'yellow' }),
})

const HIGH_CONTRAST_TONES: Readonly<Record<SemanticTone, ToneStyle>> = Object.freeze({
  accent: Object.freeze({ color: 'cyanBright' }),
  danger: Object.freeze({ color: 'redBright' }),
  // High contrast never dims: dimmed text is the first thing to fail a
  // low-vision or low-quality-terminal read.
  muted: Object.freeze({}),
  neutral: Object.freeze({}),
  positive: Object.freeze({ color: 'greenBright' }),
  warning: Object.freeze({ color: 'yellowBright' }),
})

const NO_COLOR_TONES: Readonly<Record<SemanticTone, ToneStyle>> = Object.freeze({
  accent: Object.freeze({}),
  danger: Object.freeze({}),
  muted: Object.freeze({}),
  neutral: Object.freeze({}),
  positive: Object.freeze({}),
  warning: Object.freeze({}),
})

const THEMES: Readonly<Record<TuiTheme, Readonly<Record<SemanticTone, ToneStyle>>>> = Object.freeze({
  default: DEFAULT_TONES,
  'high-contrast': HIGH_CONTRAST_TONES,
  'no-color': NO_COLOR_TONES,
})

/** The Ink `Text` props that draw a user turn as a band. */
export interface BandStyle {
  readonly backgroundColor?: string
  readonly inverse?: true
}

/**
 * How a user turn is set apart from everything around it.
 *
 * A full inversion was the first attempt and reads as a bar of glare on a dark
 * terminal: it is the strongest signal the terminal offers, spent on the most
 * ordinary row on screen. The default theme uses a raised background instead —
 * present enough to find at a glance, quiet enough to sit behind text.
 *
 * `high-contrast` keeps the inversion, which is the point of that theme, and
 * `no-color` gets no band at all: it promises no colour, and the role marker
 * already distinguishes the row.
 */
export function bandStyle(theme: TuiTheme): BandStyle {
  switch (theme) {
    case 'high-contrast': return Object.freeze({ inverse: true as const })
    case 'no-color': return Object.freeze({})
    default: return Object.freeze({ backgroundColor: 'blackBright' })
  }
}

/** Whether a band is drawn at all, so a row is padded only when it shows. */
export function bandsUserTurn(theme: TuiTheme): boolean {
  return theme !== 'no-color'
}

/**
 * Resolve one semantic tone into Ink `Text` props for a theme. The result is
 * spread, so a tone that sets nothing contributes nothing — which is what keeps
 * `exactOptionalPropertyTypes` honest about "no color" meaning absent, not
 * `undefined`.
 */
export function toneStyle(theme: TuiTheme, tone: SemanticTone | undefined): ToneStyle {
  if (tone === undefined) return {}
  return THEMES[theme][tone]
}

/**
 * Whether a theme renders any color at all. Callers use this to decide between
 * a color distinction and a textual one, rather than emitting both.
 */
export function isMonochrome(theme: TuiTheme): boolean {
  return theme === 'no-color'
}
