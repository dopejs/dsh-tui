/**
 * What the launcher should do when the profile's package version does not
 * match its own.
 *
 * Kept apart from the launcher so it can be tested without a network, a global
 * install, or a profile: the branch that matters only fires on upgrade, which
 * is exactly the path a fresh-sandbox smoke never reaches. It imports nothing
 * — a launcher that cannot start because the build it launches is broken has
 * no way to say so.
 */

/** Compare two semver-ish versions; prerelease suffixes order before release. */
export function compare(left, right) {
  const parse = value => value.split('-')[0].split('.').map(Number)
  const [leftCore, rightCore] = [parse(left), parse(right)]
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftCore[index] ?? 0) - (rightCore[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  const leftPre = left.includes('-')
  const rightPre = right.includes('-')
  if (leftPre === rightPre) return 0
  return leftPre ? -1 : 1
}

/**
 * `install` when the profile must be (re)installed before starting, `start`
 * when it can be started as it stands.
 *
 * A profile that is behind is realigned rather than refused: `npm i -g` moves
 * the launcher and nothing moves the profile, so this fires on every upgrade,
 * and the fix is one unambiguous action the launcher can take itself. Starting
 * a behind profile is not an option — dsh applies this launcher's bundle patch
 * to the older package, which fails on module resolution.
 *
 * A profile that is ahead is started as-is: the newer package brings its own
 * composition, and downgrading it would be the launcher overruling a
 * deliberate install.
 */
export function skewAction(present, own) {
  if (present === undefined) {
    return { action: 'install', reason: 'first-run' }
  }
  if (present === own) return { action: 'start', reason: 'aligned' }
  return compare(present, own) > 0
    ? { action: 'start', reason: 'profile-ahead' }
    : { action: 'install', reason: 'profile-behind' }
}
