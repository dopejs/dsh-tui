import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { Command } from 'commander'

export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const TUI_STARTUP_SERVICE = 'tuiStartup'

export interface StartupOptions {
  readonly help: boolean
  readonly resumeSessionId?: string
}

export interface TuiStartupValues {
  readonly resumeSessionId?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStartup?: TuiStartupValues
  }
}

export function parseStartupArguments(argv: readonly string[]): StartupOptions {
  let help = false
  let resumeSessionId: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--resume') {
      if (resumeSessionId !== undefined) {
        throw new Error('--resume may only be specified once')
      }
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--resume requires a session id')
      }
      resumeSessionId = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`)
  }

  return {
    help,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  }
}

export function formatHelp(): string {
  return [
    'Usage: dsh-tui [--resume <session-id>]',
    '',
    'Options:',
    '  -h, --help               Show this help.',
    '  --resume <session-id>    Resume a persisted Harness session.',
  ].join('\n')
}

function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run an interactive terminal UI for DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session-id>', 'resume a persisted Harness session')
    .addHelpText('after', `
Examples:
  dsh --profile tui                         start a new session
  dsh --profile tui --resume session-123    resume a session
`)
}

export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const resumeSessionId = program.opts<{ resume?: string }>().resume
    if (resumeSessionId?.trim() === '') {
      program.error('error: --resume requires a non-empty session id')
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
