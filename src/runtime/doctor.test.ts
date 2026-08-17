import { describe, expect, it } from 'vitest'

import {
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorEnvironment,
  type DoctorStatus,
} from './doctor'

const ALL_REQUIRED = [
  'agents',
  'agentDefaultModel',
  'commands',
  'llm',
  'sessionPersistence',
  'sessions',
  'tools',
  'userQuestions',
]

const ALL_OPTIONAL = [
  'jobs',
  'permissionPresets',
  'sessionProjections',
  'settings',
  'skills',
  'subagents',
]

function environment(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment {
  return {
    colorDisabled: false,
    envNames: [],
    services: [...ALL_REQUIRED, ...ALL_OPTIONAL],
    stdinIsTty: true,
    stdoutIsTty: true,
    ...overrides,
  }
}

function statusOf(env: DoctorEnvironment, id: string): DoctorStatus | undefined {
  return runDoctor(env).checks.find(check => check.id === id)?.status
}

describe('doctor (M5.2)', () => {
  it('reports a healthy environment as ok', () => {
    const report = runDoctor(environment({ persistence: { listable: true } }))
    expect(report.status).toBe('ok')
    expect(report.checks.every(check => check.remedy === undefined)).toBe(true)
    expect(doctorExitCode(report)).toBe(0)
  })

  it('fails on a missing required service and names it', () => {
    const report = runDoctor(environment({
      services: ALL_REQUIRED.filter(key => key !== 'llm'),
    }))
    const check = report.checks.find(entry => entry.id === 'services.required')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('llm')
    expect(check?.remedy).toContain('dsh-base')
    expect(report.status).toBe('fail')
    expect(doctorExitCode(report)).toBe(1)
  })

  // An optional service gates one panel; its absence degrades, not breaks.
  it('warns about optional services and says which panel each gates', () => {
    const report = runDoctor(environment({ services: ALL_REQUIRED }))
    const check = report.checks.find(entry => entry.id === 'services.optional')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toContain('jobs (background jobs)')
    expect(check?.detail).toContain('subagents (the subagent tree)')
    expect(report.status).toBe('warn')
    expect(doctorExitCode(report)).toBe(0)
  })

  it('warns without a TTY and points at --print', () => {
    const check = runDoctor(environment({ stdoutIsTty: false })).checks
      .find(entry => entry.id === 'tty')
    expect(check?.status).toBe('warn')
    expect(check?.detail).toContain('stdout is not a TTY')
    expect(check?.remedy).toContain('--print')
  })

  it('rejects a malformed model selector with an actionable remedy', () => {
    expect(statusOf(environment({ model: 'deepseek-official/deepseek-chat' }), 'model')).toBe('ok')
    expect(statusOf(environment({ model: 'bare-name' }), 'model')).toBe('fail')
    expect(statusOf(environment({ model: '/leading' }), 'model')).toBe('fail')
    expect(statusOf(environment({ model: 'trailing/' }), 'model')).toBe('fail')

    const check = runDoctor(environment({ model: 'bare-name' })).checks
      .find(entry => entry.id === 'model')
    expect(check?.remedy).toContain('provider/model')
  })

  it('separates persistence not queried from persistence failing', () => {
    expect(statusOf(environment(), 'persistence')).toBe('skip')
    expect(statusOf(environment({ persistence: { listable: true } }), 'persistence')).toBe('ok')

    const failing = runDoctor(environment({
      persistence: { listable: false, reason: 'EACCES on /sessions' },
    })).checks.find(entry => entry.id === 'persistence')
    expect(failing?.status).toBe('warn')
    expect(failing?.detail).toContain('EACCES')
    expect(failing?.remedy).toContain('--resume')
  })

  // A doctor report is pasted into issue trackers.
  it('reports credential-shaped variables by name and never reads a value', () => {
    const report = runDoctor(environment({
      envNames: ['DEEPSEEK_API_KEY', 'HOME', 'MY_SECRET_TOKEN', 'PATH'],
    }))
    const check = report.checks.find(entry => entry.id === 'environment')
    expect(check?.detail).toContain('DEEPSEEK_API_KEY')
    expect(check?.detail).toContain('MY_SECRET_TOKEN')
    expect(check?.detail).not.toContain('HOME')
    expect(check?.detail).toContain('values never read')
  })

  it('says so when no credential-shaped variable is set', () => {
    const check = runDoctor(environment({ envNames: ['HOME', 'PATH'] })).checks
      .find(entry => entry.id === 'environment')
    expect(check?.detail).toContain('No credential-shaped')
  })

  it('takes the worst status as the overall one', () => {
    const report = runDoctor(environment({
      model: 'bare-name',
      services: ALL_REQUIRED,
      stdoutIsTty: false,
    }))
    expect(report.status).toBe('fail')
  })

  it('reports the accessibility mode in force', () => {
    expect(runDoctor(environment({ colorDisabled: true })).checks
      .find(check => check.id === 'accessibility')?.detail).toContain('no-color theme')
    expect(runDoctor(environment()).checks
      .find(check => check.id === 'accessibility')?.detail).toContain('Color is enabled')
  })

  // The report is read by screen readers and pasted into trackers.
  it('formats as plain text with no color or box drawing', () => {
    const text = formatDoctorReport(runDoctor(environment({
      model: 'bare-name',
      services: ALL_REQUIRED,
    })))
    // Screen readers and issue trackers get plain text: no ANSI, no box drawing.
    expect(text.includes('\u001B')).toBe(false)
    expect(text).not.toMatch(/[\u2500-\u257F]/)
    expect(text).toContain('[FAIL] Model')
    expect(text).toContain('→ Pass --model as provider/model')
    expect(text).toContain('Overall: fail')
  })

  it('renders every check exactly once', () => {
    const report = runDoctor(environment({ persistence: { listable: true } }))
    const text = formatDoctorReport(report)
    for (const check of report.checks) {
      expect(text.split(`${check.title}:`)).toHaveLength(2)
    }
  })
})
