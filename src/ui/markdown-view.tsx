import { Box, Text } from 'ink'

import type { TuiTheme } from '../model/preferences-controller'
import { parseInline, parseMarkdown, type MarkdownBlock } from './markdown'
import { toneStyle } from './theme'

export interface MarkdownViewProps {
  /** Assistant text, verbatim. */
  readonly source?: string
  readonly theme: TuiTheme
}

function Inline({ text, theme }: { readonly text: string, readonly theme: TuiTheme }) {
  return (
    <>
      {parseInline(text).map((span, index) => (
        <Text
          key={index}
          {...(span.code === true ? toneStyle(theme, 'accent') : {})}
          bold={span.strong === true}
          italic={span.emphasis === true}
        >
          {span.text}
        </Text>
      ))}
    </>
  )
}

function Block({ block, theme }: { readonly block: MarkdownBlock, readonly theme: TuiTheme }) {
  const tone = (name: Parameters<typeof toneStyle>[1]) => toneStyle(theme, name)
  switch (block.kind) {
    case 'code':
      return (
        <Box flexDirection="column">
          {block.language === undefined ? null : (
            <Text {...tone('muted')} wrap="truncate-end">  {block.language}</Text>
          )}
          {block.lines.map((line, index) => (
            <Text {...tone('accent')} key={index} wrap="truncate-end">  {line}</Text>
          ))}
          {/* Reported, not hidden: the model may still be streaming. */}
          {block.unterminated ? (
            <Text {...tone('muted')} wrap="truncate-end">  [code block still open]</Text>
          ) : null}
        </Box>
      )
    case 'heading':
      return (
        <Text bold wrap="truncate-end">
          <Inline text={block.text} theme={theme} />
        </Text>
      )
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Text key={index} wrap="truncate-end">
              {'  '.repeat(item.depth)}{item.marker}{' '}
              <Inline text={item.text} theme={theme} />
            </Text>
          ))}
        </Box>
      )
    case 'quote':
      return (
        <Box flexDirection="column">
          {block.lines.map((line, index) => (
            <Text {...tone('muted')} key={index} wrap="truncate-end">
              {'\u2502 '}<Inline text={line} theme={theme} />
            </Text>
          ))}
        </Box>
      )
    case 'rule':
      return <Text {...tone('muted')}>{'\u2500'.repeat(8)}</Text>
    case 'paragraph':
      return (
        <Text wrap="truncate-end">
          <Inline text={block.text} theme={theme} />
        </Text>
      )
  }
}

/**
 * Split a message into the part that belongs on the marker line and the rest.
 *
 * A one-line answer must stay one line: pushing every reply onto its own row
 * below the marker turns a short exchange into a scroll.
 */
export function splitLeadingText(source: string): {
  readonly lead: string | undefined
  readonly rest: readonly MarkdownBlock[]
} {
  const blocks = parseMarkdown(source)
  const [first] = blocks
  if (first?.kind === 'paragraph') {
    return { lead: first.text, rest: Object.freeze(blocks.slice(1)) }
  }
  return { lead: undefined, rest: blocks }
}

/** Render inline spans of one line of text. */
export function MarkdownInline({ text, theme }: { readonly text: string, readonly theme: TuiTheme }) {
  return <Inline text={text} theme={theme} />
}

/** Render assistant text as Markdown. Never throws on malformed input. */
export function MarkdownView({ blocks, source, theme }: MarkdownViewProps & {
  readonly blocks?: readonly MarkdownBlock[]
}) {
  return (
    <Box flexDirection="column">
      {(blocks ?? parseMarkdown(source ?? '')).map((block, index) => (
        <Block block={block} key={index} theme={theme} />
      ))}
    </Box>
  )
}
