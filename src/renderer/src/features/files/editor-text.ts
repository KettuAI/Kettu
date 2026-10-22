// Text helpers for the Files pane's editor that need no editor, so they stay out of its chunk.

export type LineBreak = '\n' | '\r\n' | '\r'

/** The line break a file uses, by its first one; LF when it has none. */
export function lineBreakOf(text: string): LineBreak {
  const at = text.search(/[\r\n]/)
  if (at < 0 || text[at] === '\n') return '\n'
  return text[at + 1] === '\n' ? '\r\n' : '\r'
}

/** A change in document positions, where every line break counts as one character. */
export interface LineChange {
  from: number
  to: number
  /** The inserted text as lines, so no line break in it is ambiguous. */
  insert: string[]
}

/**
 * The one change that turns `before` into `after`, both as lines: the lines between their common
 * start and common end. A reload that changes a few lines then keeps the cursor and scroll.
 */
export function lineChange(before: string[], after: string[]): LineChange | null {
  const shorter = Math.min(before.length, after.length)
  let head = 0
  while (head < shorter && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < shorter - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  if (head === before.length && head === after.length) return null

  const starts = [0]
  for (const line of before) starts.push(starts.at(-1)! + line.length + 1)
  const start = (line: number) => starts[line]!
  const end = (line: number) => starts[line + 1]! - 1
  const removed = before.length - head - tail
  const added = after.slice(head, after.length - tail)

  if (removed > 0 && added.length > 0) {
    return { from: start(head), to: end(head + removed - 1), insert: added }
  }
  if (removed > 0) {
    // Whole lines go, with one line break: the one before them, or after them at the start.
    return head > 0
      ? { from: end(head - 1), to: end(head + removed - 1), insert: [] }
      : { from: 0, to: start(removed), insert: [] }
  }
  return head > 0
    ? { from: end(head - 1), to: end(head - 1), insert: ['', ...added] }
    : { from: 0, to: 0, insert: [...added, ''] }
}
