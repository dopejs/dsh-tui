/**
 * Types for the launcher's version-skew decision.
 *
 * Hand-written because the module itself is plain runtime ESM: the launcher
 * deliberately imports nothing from `lib/`, so this cannot be generated from a
 * bundled TypeScript source. The tests exercise the JavaScript, not this file.
 */

export declare function compare(left: string, right: string): -1 | 0 | 1

export type SkewReason = 'first-run' | 'aligned' | 'profile-ahead' | 'profile-behind'

export interface SkewDecision {
  readonly action: 'install' | 'start'
  readonly reason: SkewReason
}

export declare function skewAction(
  present: string | undefined,
  own: string,
): SkewDecision
