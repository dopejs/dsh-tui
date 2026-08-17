import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { Command } from 'commander'

import { OUTPUT_FORMATS, isOutputFormat, type OutputFormat } from './runtime/output-contract'

export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const TUI_STARTUP_SERVICE = 'tuiStartup'

export interface StartupOptions {
  readonly help: boolean
  readonly model?: string
  readonly outputFormat?: OutputFormat
  /** Run once without a terminal and exit; the prompt may be piped on stdin. */
  readonly print: boolean
  readonly prompt?: string
  readonly resumeSessionId?: string
}

export interface TuiStartupValues {
  readonly model?: string
  readonly outputFormat?: OutputFormat
  readonly print?: boolean
  readonly prompt?: string
  readonly resumeSessionId?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStartup?: TuiStartupValues
  }
}

export function parseStartupArguments(argv: readonly string[]): StartupOptions {
  let help = false
  let model: string | undefined
  let outputFormat: OutputFormat | undefined
  let print = false
  let prompt: string | undefined
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
    if (argument === '--print' || argument === '-p') {
      print = true
      continue
    }
    if (argument === '--output-format') {
      if (outputFormat !== undefined) {
        throw new Error('--output-format may only be specified once')
      }
      const value = argv[index + 1]
      if (value === undefined || !isOutputFormat(value)) {
        throw new Error(`--output-format must be one of ${OUTPUT_FORMATS.join(', ')}`)
      }
      outputFormat = value
      index += 1
      continue
    }
    if (argument !== undefined && !argument.startsWith('-') && prompt === undefined) {
      prompt = argument
      continue
    }
    if (argument === '--model') {
      if (model !== undefined) throw new Error('--model may only be specified once')
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--model requires provider/model')
      }
      model = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`)
  }
  if (model !== undefined && resumeSessionId !== undefined) {
    throw new Error('--model cannot be combined with --resume')
  }
  // The format only describes --print output; accepting it otherwise would
  // promise a contract the interactive runtime does not emit.
  if (outputFormat !== undefined && !print) {
    throw new Error('--output-format requires --print')
  }
  if (prompt !== undefined && !print) {
    throw new Error('a prompt argument requires --print')
  }

  return {
    help,
    ...(model === undefined ? {} : { model }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    print,
    ...(prompt === undefined ? {} : { prompt }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  }
}

export function formatHelp(): string {
  return [
    'Usage: dsh-tui [--model <provider/model>] [--resume <session-id>]',
    '       dsh-tui --print [--output-format <text|json|stream-json>] [prompt]',
    '',
    'Options:',
    '  -h, --help               Show this help.',
    '  --model <provider/model>  Select a model for a new session.',
    '  --resume <session-id>    Resume a persisted Harness session.',
    '  -p, --print              Run once without a terminal and exit.',
    '  --output-format <fmt>    text (default), json, or stream-json; needs --print.',
  ].join('\n')
}

function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run an interactive terminal UI for DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .option('--model <provider/model>', 'select a model for a new session')
    .option('--resume <session-id>', 'resume a persisted Harness session')
    .option('-p, --print', 'run once without a terminal and exit')
    .option(
      '--output-format <format>',
      `output contract for --print: ${OUTPUT_FORMATS.join(', ')}`,
    )
    .argument('[prompt]', 'prompt for --print; omitted reads stdin')
    .addHelpText('after', `
Examples:
  dsh --profile tui                         start a new session
  dsh --profile tui --model deepseek-official/deepseek-chat
  dsh --profile tui --resume session-123    resume a session
`)
}

export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((prompt?: string) => {
    const {
      model,
      outputFormat,
      print = false,
      resume: resumeSessionId,
    } = program.opts<{
      model?: string
      outputFormat?: string
      print?: boolean
      resume?: string
    }>()
    if (resumeSessionId?.trim() === '') {
      program.error('error: --resume requires a non-empty session id')
    }
    if (model?.trim() === '') program.error('error: --model requires provider/model')
    if (model !== undefined && resumeSessionId !== undefined) {
      program.error('error: --model cannot be combined with --resume')
    }
    if (outputFormat !== undefined && !isOutputFormat(outputFormat)) {
      program.error(`error: --output-format must be one of ${OUTPUT_FORMATS.join(', ')}`)
    }
    if (outputFormat !== undefined && !print) {
      program.error('error: --output-format requires --print')
    }
    if (prompt !== undefined && !print) {
      program.error('error: a prompt argument requires --print')
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(model === undefined ? {} : { model }),
      ...(outputFormat === undefined || !isOutputFormat(outputFormat)
        ? {}
        : { outputFormat }),
      print,
      ...(prompt === undefined ? {} : { prompt }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
