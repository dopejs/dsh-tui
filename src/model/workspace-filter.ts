/**
 * Workspace grouping for persisted sessions.
 *
 * The only durable workspace fact a session carries is its header `cwd`. There
 * is no worktree service on this baseline, so a "worktree" here means exactly
 * what the caller can prove: a directory that a session was started in, plus an
 * optional set of roots the launcher discovered. Nothing is inferred from the
 * filesystem, because a session's recorded cwd may no longer exist.
 */

const MAX_PATH_CODE_UNITS = 300

export interface WorkspaceSession {
  readonly cwd?: string
  readonly id: string
}

export interface WorkspaceGroup {
  /** Number of sessions recorded in this root. */
  readonly count: number
  /** Shortest label that still distinguishes this root from the others. */
  readonly label: string
  readonly root: string
}

export interface WorkspaceFilterResult {
  readonly groups: readonly WorkspaceGroup[]
  /** Sessions whose header carries no cwd; they belong to no root. */
  readonly unknownCount: number
}

function boundedPath(value: string): string {
  return value.length <= MAX_PATH_CODE_UNITS
    ? value
    : `…${value.slice(value.length - MAX_PATH_CODE_UNITS + 1)}`
}

/** Normalize a path for comparison without touching the filesystem. */
export function normalizeRoot(value: string): string {
  const collapsed = value.replaceAll('\\', '/').replace(/\/+$/u, '')
  return collapsed === '' ? '/' : collapsed
}

/**
 * The last path segment, which is what distinguishes sibling worktrees. Falls
 * back to the whole root when there is no segment to take.
 */
function leafOf(root: string): string {
  const index = root.lastIndexOf('/')
  const leaf = index < 0 ? root : root.slice(index + 1)
  return leaf === '' ? root : leaf
}

/**
 * Group sessions by the workspace root they were started in.
 *
 * Labels are shortened to the last path segment, but only while that stays
 * unambiguous — two worktrees of one repository share a leaf name, and showing
 * both as `main` would make the list useless precisely where it matters.
 */
export function groupByWorkspace(
  sessions: readonly WorkspaceSession[],
): WorkspaceFilterResult {
  const counts = new Map<string, number>()
  let unknownCount = 0
  for (const session of sessions) {
    if (session.cwd === undefined || session.cwd === '') {
      unknownCount += 1
      continue
    }
    const root = normalizeRoot(session.cwd)
    counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  const roots = [...counts.keys()].sort()
  const leaves = new Map<string, number>()
  for (const root of roots) {
    const leaf = leafOf(root)
    leaves.set(leaf, (leaves.get(leaf) ?? 0) + 1)
  }
  const groups = roots.map((root) => {
    const leaf = leafOf(root)
    const ambiguous = (leaves.get(leaf) ?? 0) > 1
    return Object.freeze({
      count: counts.get(root) ?? 0,
      label: boundedPath(ambiguous ? root : leaf),
      root,
    })
  })
  return Object.freeze({ groups: Object.freeze(groups), unknownCount })
}

/**
 * Keep the sessions recorded in one root. A session with no cwd is excluded:
 * it cannot be proven to belong to the root, and including it would make the
 * filter mean "this root, plus anything we could not place".
 */
export function filterByWorkspace<T extends WorkspaceSession>(
  sessions: readonly T[],
  root: string | undefined,
): readonly T[] {
  if (root === undefined) return sessions
  const normalized = normalizeRoot(root)
  return Object.freeze(sessions.filter(
    session => session.cwd !== undefined && normalizeRoot(session.cwd) === normalized,
  ))
}

/**
 * Whether the launcher can move the process between workspaces.
 *
 * A workspace transition means changing the process's working directory, which
 * the launcher owns — the TUI runs inside an already-composed process and
 * cannot re-root it without invalidating every live handle. So this is reported
 * rather than performed: the user is told which root to relaunch in.
 */
export type WorkspaceTransition = 'launcher-owned'

export function relaunchHintFor(root: string): string {
  return `Start dsh from ${boundedPath(normalizeRoot(root))} to work in that worktree.`
}
