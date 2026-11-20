// How Settings' search matches its rows, shared with the settings tools so an agent's words find
// what the page's search finds.

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

const WORD = /[\p{L}\p{N}]/u
// Chinese and Japanese run their words together, so any character can start one.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

function startsWord(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text[at - 1]!
  return !WORD.test(before) || UNSPACED.test(before) || UNSPACED.test(text[at]!)
}

/** Where `word` starts a word of `lower`, so "sh" finds Shell but not finished. */
export function wordStarts(lower: string, word: string): number[] {
  const found: number[] = []
  for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) {
    if (startsWord(lower, at)) found.push(at)
  }
  return found
}

/** Whether every word of the query starts a word of the text. */
export function matchesWords(text: string, query: string): boolean {
  const lower = text.toLowerCase()
  return queryWords(query).every((word) => wordStarts(lower, word).length > 0)
}
