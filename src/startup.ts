export interface StartupOptions {
  readonly help: boolean
  readonly resumeSessionId?: string
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
