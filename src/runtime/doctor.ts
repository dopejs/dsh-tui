/**
 * Read-only environment diagnosis for `--doctor`.
 *
 * Every check observes; none of them writes, connects, resumes a session, or
 * executes a tool. A diagnostic that changed the thing it was diagnosing would
 * be worse than no diagnostic at all.
 */

export type DoctorStatus = 'fail' | 'ok' | 'skip' | 'warn'

export interface DoctorCheck {
  readonly detail: string
  readonly id: string
  /** What the user can actually do about it; absent when nothing is wrong. */
  readonly remedy?: string
  readonly status: DoctorStatus
  readonly title: string
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[]
  /** The worst status any check reported. */
  readonly status: DoctorStatus
}

export interface DoctorEnvironment {
  /** Service keys the composition resolves, in any order. */
  readonly services: readonly string[]
  readonly stdinIsTty: boolean
  readonly stdoutIsTty: boolean
  /** Environment variable names only; values are never read. */
  readonly envNames: readonly string[]
  readonly colorDisabled: boolean
  /** Resolved startup model selector, when one was given. */
  readonly model?: string
  /** Whether the persistence backend can list sessions, when it was asked. */
  readonly persistence?: { readonly listable: boolean, readonly reason?: string }
}

/** Services the TUI cannot start without. */
const REQUIRED_SERVICES: readonly string[] = [
  'agents',
  'agentDefaultModel',
  'commands',
  'llm',
  'sessionPersistence',
  'sessions',
  'tools',
  'userQuestions',
]

/** Services that each gate one panel; absence degrades rather than breaks. */
const OPTIONAL_SERVICES: readonly { readonly key: string, readonly panel: string }[] = [
  { key: 'jobs', panel: 'background jobs' },
  { key: 'permissionPresets', panel: 'permissions' },
  { key: 'sessionProjections', panel: 'plan, todo, goal, and usage' },
  { key: 'settings', panel: 'persisted preferences' },
  { key: 'skills', panel: 'skills' },
  { key: 'subagents', panel: 'the subagent tree' },
]

/**
 * Environment variables whose *names* alone suggest a credential. Only names
 * are ever compared, and only names are ever reported — a doctor report is the
 * kind of output users paste into issues.
 */
const SECRET_NAME = /(?:key|secret|token|password|credential|auth)/i

const STATUS_RANK: Readonly<Record<DoctorStatus, number>> = Object.freeze({
  fail: 3,
  ok: 0,
  skip: 1,
  warn: 2,
})

function worst(checks: readonly DoctorCheck[]): DoctorStatus {
  let status: DoctorStatus = 'ok'
  for (const check of checks) {
    if (STATUS_RANK[check.status] > STATUS_RANK[status]) status = check.status
  }
  return status
}

export function runDoctor(environment: DoctorEnvironment): DoctorReport {
  const present = new Set(environment.services)
  const checks: DoctorCheck[] = []

  const missing = REQUIRED_SERVICES.filter(key => !present.has(key))
  checks.push(missing.length === 0
    ? {
        detail: `All ${String(REQUIRED_SERVICES.length)} required Harness services resolve.`,
        id: 'services.required',
        status: 'ok',
        title: 'Required services',
      }
    : {
        detail: `Missing: ${missing.join(', ')}.`,
        id: 'services.required',
        remedy: 'Load the dsh-base profile, or add these plugins to your cordis.yml.',
        status: 'fail',
        title: 'Required services',
      })

  const absent = OPTIONAL_SERVICES.filter(entry => !present.has(entry.key))
  checks.push(absent.length === 0
    ? {
        detail: 'Every optional panel has its backing service.',
        id: 'services.optional',
        status: 'ok',
        title: 'Optional services',
      }
    : {
        detail: absent.map(entry => `${entry.key} (${entry.panel})`).join(', '),
        id: 'services.optional',
        remedy: 'These panels report themselves unavailable; add the plugin to enable one.',
        status: 'warn',
        title: 'Optional services',
      })

  const interactive = environment.stdinIsTty && environment.stdoutIsTty
  checks.push(interactive
    ? { detail: 'stdin and stdout are TTYs.', id: 'tty', status: 'ok', title: 'Terminal' }
    : {
        detail: `stdin ${environment.stdinIsTty ? 'is' : 'is not'} a TTY; `
          + `stdout ${environment.stdoutIsTty ? 'is' : 'is not'} a TTY.`,
        id: 'tty',
        remedy: 'Run in a terminal, or use --print for non-interactive output.',
        status: 'warn',
        title: 'Terminal',
      })

  if (environment.model === undefined) {
    checks.push({
      detail: 'No --model given; the agent default selection applies.',
      id: 'model',
      status: 'ok',
      title: 'Model',
    })
  } else {
    const separator = environment.model.indexOf('/')
    const valid = separator > 0 && separator < environment.model.length - 1
    checks.push(valid
      ? { detail: `Requested ${environment.model}.`, id: 'model', status: 'ok', title: 'Model' }
      : {
          detail: `"${environment.model}" is not provider/model.`,
          id: 'model',
          remedy: 'Pass --model as provider/model, for example deepseek-official/deepseek-chat.',
          status: 'fail',
          title: 'Model',
        })
  }

  const persistence = environment.persistence
  checks.push(persistence === undefined
    ? {
        detail: 'Session persistence was not queried.',
        id: 'persistence',
        status: 'skip',
        title: 'Session persistence',
      }
    : persistence.listable
      ? {
          detail: 'Persisted sessions can be listed.',
          id: 'persistence',
          status: 'ok',
          title: 'Session persistence',
        }
      : {
          detail: persistence.reason ?? 'Listing persisted sessions failed.',
          id: 'persistence',
          remedy: 'Check the session store path and its permissions; --resume needs it.',
          status: 'warn',
          title: 'Session persistence',
        })

  // Names only. A doctor report is pasted into issues, so values never appear.
  const secretNames = environment.envNames.filter(name => SECRET_NAME.test(name)).sort()
  checks.push({
    detail: secretNames.length === 0
      ? 'No credential-shaped environment variable names are set.'
      : `Set (names only, values never read): ${secretNames.join(', ')}.`,
    id: 'environment',
    status: 'ok',
    title: 'Environment',
  })

  checks.push({
    detail: environment.colorDisabled
      ? 'Color is disabled; the no-color theme carries every distinction as text.'
      : 'Color is enabled.',
    id: 'accessibility',
    status: 'ok',
    title: 'Accessibility',
  })

  const frozen = Object.freeze(checks.map(check => Object.freeze(check)))
  return Object.freeze({ checks: frozen, status: worst(frozen) })
}

const MARK: Readonly<Record<DoctorStatus, string>> = Object.freeze({
  fail: 'FAIL',
  ok: 'ok  ',
  skip: 'skip',
  warn: 'warn',
})

/**
 * Render the report as plain text. No color and no box drawing: this output is
 * read by screen readers and pasted into issue trackers.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['dsh-tui doctor', '']
  for (const check of report.checks) {
    lines.push(`[${MARK[check.status]}] ${check.title}: ${check.detail}`)
    if (check.remedy !== undefined) lines.push(`         → ${check.remedy}`)
  }
  lines.push('', `Overall: ${report.status}`)
  return `${lines.join('\n')}\n`
}

/** `fail` is the only non-zero outcome; a warning is informational. */
export function doctorExitCode(report: DoctorReport): number {
  return report.status === 'fail' ? 1 : 0
}
