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
