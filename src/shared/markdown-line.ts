// An answer's first line as plain text, for a routine run's row and its notification.

import { GFM, parser } from '@lezer/markdown'

const markdown = parser.configure(GFM)
type SyntaxNode = ReturnType<typeof markdown.parse>['topNode']

/** How much of an answer is parsed: enough to hold any first line. */
const HEAD = 4_000

// Blocks that hold other blocks, and the blocks whose text a line can show.
const CONTAINERS = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])
const TEXT_BLOCK =
  /^(?:Paragraph|ATXHeading\d|SetextHeading\d|Task|FencedCode|CodeBlock|Table|HTMLBlock)$/
const MARKS = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'LinkTitle',
])

/** A node's text without its marks, escapes resolved; a link's or image's address left out. */
function textOf(node: SyntaxNode, source: string): string {
  let text = ''
  let at = node.from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    text += source.slice(at, child.from)
    at = child.to
    if (MARKS.has(child.name)) continue
    // An address written out is the text itself; only a link's or image's is left out.
    if (child.name === 'URL' && (node.name === 'Link' || node.name === 'Image')) continue
    if (child.name === 'Escape') text += source.slice(child.from + 1, child.to)
    else if (child.name === 'HardBreak') text += '\n'
    else text += textOf(child, source)
  }
  return text + source.slice(at, node.to)
}

function firstLineIn(node: SyntaxNode, source: string): string {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    let line = ''
    if (CONTAINERS.has(child.name)) line = firstLineIn(child, source)
    else if (TEXT_BLOCK.test(child.name)) {
      for (const part of textOf(child, source).split('\n')) {
        line = part.replace(/\s+/g, ' ').trim()
        if (line) break
      }
    }
    if (line) return line
  }
  return ''
}

/**
 * The first line of text in Markdown, as plain text: the first line of the first block with any,
 * without heading, quote, list, task, emphasis, strikethrough, code or link marks, and spaces
 * collapsed. A link shows its text, an image its alt text, and a code fence its first line of code.
 */
export function markdownFirstLine(text: string): string {
  const source = text.slice(0, HEAD)
  return firstLineIn(markdown.parse(source).topNode, source)
}
