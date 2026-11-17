// Marks the words of a find in the text of a thread with the CSS Custom Highlight API, which
// paints a background behind ranges without touching the nodes, so selecting and copying are
// unaffected and a re-render of Markdown leaves nothing behind.

import { fold } from '@shared/search-fold'

const MATCH = 'find-match'
const CURRENT = 'find-current'
// A word like "a" in a very long reply would make thousands of ranges.
const MAX_RANGES = 2_000

/** What marks a message's text: a reply's Markdown, and the bubble of a message sent. */
export const MESSAGE_BODY = '[data-agent-message], .ks-user__bubble'

export const marksSupported = (): boolean =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

/** Ranges over each place the folded `words` occur in the text of `root`, in no set order. */
export function rangesOf(root: Element, words: readonly string[]): Range[] {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
    starts.push(text.length)
    text += (node as Text).data
  }
  if (nodes.length === 0) return []
  const folded = fold(text)

  // The node an offset of the joined text is in; one that ends a range belongs to the node before.
  const place = (offset: number, ends: boolean): [Text, number] => {
    let low = 0
    let high = nodes.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (ends ? starts[mid]! < offset : starts[mid]! <= offset) low = mid
      else high = mid - 1
    }
    const node = nodes[low]!
    return [node, Math.min(offset - starts[low]!, node.length)]
  }

  const out: Range[] = []
  for (const word of words) {
    if (word === '') continue
    const next = (from: number): number => folded.text.indexOf(word, from)
    for (let at = next(0); at !== -1; at = next(at + word.length)) {
      if (out.length >= MAX_RANGES) return out
      const range = new Range()
      range.setStart(...place(folded.from[at]!, false))
      range.setEnd(...place(folded.from[at + word.length]!, true))
      out.push(range)
    }
  }
  return out
}

/** Whoever set the marks last, so a find that closes clears only its own. */
let owner: object | null = null

/** Paints `others` as found and `current` as the match stepped to. */
export function setMarks(by: object, others: readonly Range[], current: readonly Range[]): void {
  if (!marksSupported()) return
  owner = by
  CSS.highlights.set(MATCH, new Highlight(...others))
  CSS.highlights.set(CURRENT, new Highlight(...current))
}

export function clearMarks(by: object): void {
  if (!marksSupported() || owner !== by) return
  owner = null
  CSS.highlights.delete(MATCH)
  CSS.highlights.delete(CURRENT)
}
