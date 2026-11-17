// How Search reads text: without case or accents. The host and the window share it, so what the
// host finds is what the window marks.

interface Folded {
  text: string
  /** For each character of `text`, where it starts in the original; one more for the end. */
  from: number[]
}

function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** The text without case and accents, remembering where each character came from. */
export function fold(text: string): Folded {
  let folded = ''
  const from: number[] = []
  let at = 0
  for (const char of text) {
    const next = foldChar(char)
    for (let i = 0; i < next.length; i++) from.push(at)
    folded += next
    at += char.length
  }
  from.push(at)
  return { text: folded, from }
}

/** The text as matching reads it: no case, no accents. */
export function foldText(text: string): string {
  return fold(text).text
}

/**
 * `foldText` of a long text in one pass, which is several times faster and, without the mapping
 * back, enough to tell whether words occur in it.
 */
export function foldBulk(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}

/** The words of a query, folded. */
export function queryWords(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean)
}

/** A search of what was said needs at least this many characters, of every word together. */
const CONVERSATION_QUERY_MIN = 2

/** Whether the words of a query are enough to search the conversations for. */
export function longEnough(words: readonly string[]): boolean {
  return Array.from(words.join('')).length >= CONVERSATION_QUERY_MIN
}
