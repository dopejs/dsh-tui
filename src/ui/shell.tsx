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
      <Text>Milestone 1 lifecycle shell</Text>
      <Text dimColor>
        {resumeSessionId === undefined
          ? 'new session (agent attachment not implemented)'
          : `resume ${resumeSessionId} (agent attachment not implemented)`}
      </Text>
      <Text dimColor>Press q or Ctrl-C to exit.</Text>
    </Box>
  )
}
