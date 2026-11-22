// Where a comment on a document points: one of its top-level blocks, a paragraph, a heading, a
// list, a table, a picture or code, by where it starts in `document.md`, the element name it shows
// as and the start of its words. A later version moves it to the same kind of block with the same
// words, or marks it missing. The viewer makes these and the host moves them, with the same rules.

import { markdownBlocks, type MarkdownBlock } from './artifact-document'
import { CONTENT_ENTRIES } from './artifact-types'
import { snippet } from './artifact-runtime/page-messages'

/** The file a document's anchors point into. */
export const DOCUMENT_ENTRY = CONTENT_ENTRIES.document

/** The element a block shows as, by the parser's name for it. */
export function blockTag(kind: string): string {
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(kind)
  if (heading) return `h${heading[1]}`
  switch (kind) {
    case 'Paragraph':
      return 'p'
    case 'BulletList':
      return 'ul'
    case 'OrderedList':
      return 'ol'
    case 'Table':
      return 'table'
    case 'FencedCode':
    case 'CodeBlock':
      return 'pre'
    case 'Blockquote':
      return 'blockquote'
    case 'HorizontalRule':
      return 'hr'
    default:
      return 'div'
  }
}

/** A block's words as a reader sees them, its Markdown marks dropped, on one line. */
export function plainWords(source: string): string {
  return (
    source
      // Fences and their info line.
      .replace(/^\s*(?:```|~~~)[^\n]*$/gm, ' ')
      // Heading, quote and list marks at the start of a line.
      .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
      // Setext underlines and table rules.
      .replace(/^\s*(?:=+|-+|\|?[\s:|-]+\|[\s:|-]*)\s*$/gm, ' ')
      // Pictures and links keep their words.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/\|/g, ' ')
      // Emphasis, strike and code marks; an underscore inside a word is a letter of it.
      .replace(/(?<!\\)[*~`]+/g, '')
      .replace(/(^|[^\p{L}\p{N}\\])_+|(?<!\\)_+(?![\p{L}\p{N}])/gu, '$1')
      .replace(/\\(.)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * The start of a block's words, at most SNIPPET_CHARS long: what an anchor keeps to find the block
 * again.
 */
export function blockWords(source: string): string {
  return snippet(plainWords(source))
}

/** A document's blocks a comment can point at: every top-level one but link definitions. */
export function anchorBlocks(markdown: string): MarkdownBlock[] {
  return markdownBlocks(markdown).filter((block) => block.kind !== 'LinkReference')
}

/** How many of an anchor's first characters still find a block whose later words were changed. */
const LEAD_CHARS = 24

/** How much of an anchor's words a block whose early words were changed must still share. */
const SHARED_WORDS = 0.6

/** The share of words two texts have in common, against the longer of the two. */
function sharedWords(a: string, b: string): number {
  const count = (text: string) => {
    const counts = new Map<string, number>()
    for (const word of text.toLocaleLowerCase().split(/\s+/)) {
      if (word) counts.set(word, (counts.get(word) ?? 0) + 1)
    }
    return counts
  }
  const left = count(a)
  const right = count(b)
  const size = (counts: Map<string, number>) => [...counts.values()].reduce((x, y) => x + y, 0)
  let common = 0
  for (const [word, n] of left) common += Math.min(n, right.get(word) ?? 0)
  return common / Math.max(1, size(left), size(right))
}

/**
 * Where the block an anchor pointed at starts in `markdown`, a later version: the block of the
 * same element whose words start with the anchor's, else with their first LEAD_CHARS, nearest its
 * old place; else the one that shares most of its words, at least SHARED_WORDS of them; without
 * words, a block of that element still at its place. Null when there is none.
 */
export function findDocumentAnchor(
  markdown: string,
  anchor: { offset: number; tag: string; text: string },
): number | null {
  const blocks = anchorBlocks(markdown).filter((block) => blockTag(block.kind) === anchor.tag)
  if (anchor.text === '') return blocks.find((block) => block.from === anchor.offset)?.from ?? null
  const words = blocks.map((block) => blockWords(markdown.slice(block.from, block.to)))
  const nearest = (lead: string): number | null => {
    let best: { from: number; distance: number } | null = null
    blocks.forEach((block, i) => {
      if (!words[i]!.startsWith(lead)) return
      const distance = Math.abs(block.from - anchor.offset)
      if (!best || distance < best.distance) best = { from: block.from, distance }
    })
    return (best as { from: number } | null)?.from ?? null
  }
  const lead = Array.from(anchor.text).slice(0, LEAD_CHARS).join('')
  const found = nearest(anchor.text) ?? (lead === anchor.text ? null : nearest(lead))
  if (found !== null) return found
  // Only as many of a block's words as an anchor keeps are compared.
  const kept = Array.from(anchor.text).length
  let best: { from: number; share: number; distance: number } | null = null
  blocks.forEach((block, i) => {
    const share = sharedWords(anchor.text, Array.from(words[i]!).slice(0, kept).join(''))
    if (share < SHARED_WORDS) return
    const distance = Math.abs(block.from - anchor.offset)
    if (!best || share > best.share || (share === best.share && distance < best.distance))
      best = { from: block.from, share, distance }
  })
  return (best as { from: number } | null)?.from ?? null
}
