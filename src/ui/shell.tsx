import { useEffect } from 'react'
import { Box, Text, useInput } from 'ink'

interface ShellProps {
  readonly crashAfterRender?: boolean
  readonly onQuit: () => void
  readonly resumeSessionId?: string
}

export function Shell({ crashAfterRender = false, onQuit, resumeSessionId }: ShellProps) {
  useEffect(() => {
    if (crashAfterRender) {
      throw new Error('Injected post-render failure')
    }
  }, [crashAfterRender])

  useInput((input, key) => {
    if (input === 'q' || (input === 'c' && key.ctrl)) {
      onQuit()
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold>dsh-tui</Text>
      <Text>Standalone terminal lifecycle fixture</Text>
      <Text dimColor>
        {resumeSessionId === undefined
          ? 'fresh-session terminal path'
          : `resume ${resumeSessionId} terminal path`}
      </Text>
      <Text dimColor>Press q or Ctrl-C to exit.</Text>
    </Box>
  )
}
