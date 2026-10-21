import { parseMarkdownIntoBlocks } from 'streamdown'

/** A chunk is cut once the text after the previous one grows past this many characters. */
export const CHUNK_SIZE = 8_000

// The last blocks can still change as text arrives: a paragraph becomes a setext heading, a list
// takes another item, and a cut at the window's edge leaves the last block incomplete.
const LIVE_BLOCKS = 2

// Footnotes and link definitions resolve across the whole text, which Streamdown then renders as
// one block; these are its own tests for them.
const FOOTNOTE = /\[\^[\w-]{1,200}\]/
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:/m

export interface Chunks {
  /** Joined, the text. All but the last are settled; the last is the live tail. */
  chunks: string[]
  /** The text length at which the tail is looked at again. */
  retryAt: number
}

/**
 * Splits markdown into chunks that end on block boundaries, so a long message renders as settled
 * chunks that never change plus a live tail, and each streamed update costs the tail rather than
 * the whole message. When the text only grew since `previous`, its settled chunks are kept as
 * they are, and the tail is lexed again only every few thousand characters.
 */
export function splitIntoChunks(text: string, previous?: Chunks): Chunks {
  const chunks: string[] = []
  let offset = 0
  for (const chunk of previous?.chunks.slice(0, -1) ?? []) {
    if (!text.startsWith(chunk, offset)) break
    chunks.push(chunk)
    offset += chunk.length
  }
  const kept = previous !== undefined && chunks.length === previous.chunks.length - 1
  // Settled chunks hold neither, so only the text after them needs the test.
  const rest = text.slice(offset)
  if (FOOTNOTE.test(rest) || LINK_DEFINITION.test(rest)) {
    return { chunks: [text], retryAt: 0 }
  }
  if (kept && text.length < previous.retryAt)
    return { chunks: [...chunks, rest], retryAt: previous.retryAt }
  for (;;) {
    const length = settledLength(text, offset)
    if (length === 0) break
    chunks.push(text.slice(offset, offset + length))
    offset += length
  }
  const tail = text.length - offset
  return {
    chunks: [...chunks, text.slice(offset)],
    // A tail too long to settle is one large block still arriving; it is looked at again after
    // half a chunk more.
    retryAt: tail > CHUNK_SIZE ? text.length + CHUNK_SIZE / 2 : offset + CHUNK_SIZE + 1,
  }
}

/** The length of the next chunk from `offset`, or 0 when what follows is still live. */
function settledLength(text: string, offset: number): number {
  const rest = text.length - offset
  if (rest <= CHUNK_SIZE) return 0
  // Lexing a window rather than the rest keeps a long finished message linear to split.
  for (let window = 2 * CHUNK_SIZE; ; window *= 2) {
    const blocks = parseMarkdownIntoBlocks(text.slice(offset, offset + window))
    let length = 0
    for (const block of blocks.slice(0, -LIVE_BLOCKS)) {
      length += block.length
      if (length >= CHUNK_SIZE) break
    }
    if (length > 0 || window >= rest) return length
  }
}
