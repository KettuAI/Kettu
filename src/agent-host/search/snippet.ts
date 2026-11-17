// What a search of the stored messages shows of a match: the text around it, on one line.

import { fold } from '@shared/search-fold'

// Text kept before the first match, so it shows within a one-line row, and from the match on.
const LEAD = 24
const SPAN = 160

/**
 * The part of `text` around the first occurrence of `word` in `folded`, the same text as
 * `foldBulk` reads it, with its whitespace made single spaces and an ellipsis at each cut end.
 */
export function snippetOf(text: string, folded: string, word: string): string {
  let at = folded.indexOf(word)
  // Characters that fold to more or fewer units moved the match; map it back exactly.
  if (folded.length !== text.length) {
    const exact = fold(text)
    const found = exact.text.indexOf(word)
    at = found < 0 ? -1 : (exact.from[found] ?? -1)
  }
  if (at < 0) at = 0
  let start = Math.max(0, at - LEAD)
  let end = Math.min(text.length, at + SPAN)
  // A cut must not split a surrogate pair.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start++
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end--
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}
