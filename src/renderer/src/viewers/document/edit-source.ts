// A block's text typed in place, back into its Markdown: each text node the block rendered is
// found in the block's source when editing starts, and the words typed into it replace that stretch
// of source, so links, emphasis and code around them stay as they were.

import { blockMarks } from '@shared/artifact-document'

interface Run {
  node: Text
  /** Where the node's text lies in the block's source; null when it is not there as written. */
  from: number | null
  to: number
  text: string
  /** Inside code, where Markdown marks are text. */
  code: boolean
}

export interface SourceMap {
  source: string
  runs: Run[]
}

function textNodes(root: Element): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

/** The end of the bracketed part that opens at `open`, or -1 when it never closes. */
function closing(source: string, open: number, left: string, right: string): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < source.length; i++) {
    const char = source[i]!
    if (char === '\\') i++
    else if (quote) quote = char === quote ? '' : quote
    else if (left === '(' && (char === '"' || char === "'" || char === '<')) {
      // A title or a bracketed address may hold parentheses of its own.
      if (/[\s(]/.test(source[i - 1]!)) quote = char === '<' ? '>' : char
    } else if (char === left) depth++
    else if (char === right && --depth === 0) return i + 1
  }
  return -1
}

/**
 * The stretches of the source that are never shown as words: the address and title of a link, its
 * reference label, and an image whole.
 */
function hidden(source: string): [number, number][] {
  const spans: [number, number][] = []
  if (/^\s*(```|~~~)/.test(source)) return spans
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === '\\') {
      i++
    } else if (char === '`') {
      const ticks = /^`+/.exec(source.slice(i))![0]
      const end = source.indexOf(ticks, i + ticks.length)
      i = end < 0 ? i + ticks.length - 1 : end + ticks.length - 1
    } else if (char === '!' && source[i + 1] === '[') {
      const alt = closing(source, i + 1, '[', ']')
      if (alt < 0) continue
      const rest =
        source[alt] === '('
          ? closing(source, alt, '(', ')')
          : source[alt] === '['
            ? closing(source, alt, '[', ']')
            : alt
      spans.push([i, rest < 0 ? alt : rest])
      i = (rest < 0 ? alt : rest) - 1
    } else if (char === ']' && (source[i + 1] === '(' || source[i + 1] === '[')) {
      const end =
        source[i + 1] === '(' ? closing(source, i + 1, '(', ')') : closing(source, i + 1, '[', ']')
      if (end < 0) continue
      spans.push([i + 1, end])
      i = end - 1
    }
  }
  return spans
}

/** Where `text` is written as words at or after `from`, or -1. */
function find(
  source: string,
  text: string,
  from: number,
  spans: [number, number][],
  marks: [number, number][],
): number {
  // A match that holds a span whole shows it as words, so the brackets were no link there.
  const inside = (at: number): boolean =>
    spans.some(
      ([start, end]) =>
        at < end && at + text.length > start && !(at <= start && at + text.length >= end),
    ) || marks.some(([start, end]) => at < end && at + text.length > start)
  let at = source.indexOf(text, from)
  while (at >= 0 && inside(at)) at = source.indexOf(text, at + 1)
  return at
}

/**
 * Finds the block's rendered words in its source, in order. A code block's source is all words: an
 * indented one starts after its indent, where a line can read as a list item or a heading.
 */
export function mapSource(root: Element, source: string, codeBlock: boolean): SourceMap {
  const runs: Run[] = []
  const spans = hidden(source)
  // Words the same as their item's or heading's mark are written after it, never on it.
  const marks = codeBlock ? [] : blockMarks(source)
  let cursor = 0
  for (const node of textNodes(root)) {
    const text = node.data
    const code = !!node.parentElement?.closest('code, pre')
    if (text.trim() === '') {
      runs.push({ node, from: null, to: cursor, text, code })
      continue
    }
    const at = find(source, text, cursor, spans, marks)
    if (at < 0) {
      runs.push({ node, from: null, to: cursor, text, code })
      continue
    }
    cursor = at + text.length
    runs.push({ node, from: at, to: cursor, text, code })
  }
  return { source, runs }
}

/** What typed text must escape to stay words: the marks that start or end Markdown's inline parts. */
function escape(text: string): string {
  return text.replace(/[\\`*_[\]<>~]/g, (mark) => `\\${mark}`)
}

/** The node's new text with what was typed into it escaped and what was there kept as written. */
function typed(was: string, now: string, code: boolean): string {
  if (code) return now
  let start = 0
  while (start < was.length && start < now.length && was[start] === now[start]) start++
  let end = 0
  while (
    end < was.length - start &&
    end < now.length - start &&
    was[was.length - 1 - end] === now[now.length - 1 - end]
  ) {
    end++
  }
  return (
    now.slice(0, start) + escape(now.slice(start, now.length - end)) + now.slice(now.length - end)
  )
}

/**
 * The block's source with what was typed since `map` was made, or null when the typing touched
 * words that could not be found in the source, which then cannot be changed in place.
 */
export function editedSource(root: Element, map: SourceMap): string | null {
  const edits: { from: number; to: number; text: string }[] = []
  const known = new Map(map.runs.map((run) => [run.node, run]))
  const seen = new Set<Text>()
  // Where text typed outside the nodes found goes: after the last node found before it.
  let at = 0
  for (const node of textNodes(root)) {
    const run = known.get(node)
    if (run) {
      seen.add(node)
      if (run.from !== null) at = run.to
      if (node.data === run.text) continue
      if (run.from === null) {
        if (run.text.trim() !== '' || node.data.trim() !== '') return null
        continue
      }
      edits.push({ from: run.from, to: run.to, text: typed(run.text, node.data, run.code) })
    } else if (node.data !== '') {
      const code = !!node.parentElement?.closest('code, pre')
      edits.push({ from: at, to: at, text: code ? node.data : escape(node.data) })
    }
  }
  for (const run of map.runs) {
    if (seen.has(run.node) || run.text.trim() === '') continue
    if (run.from === null) return null
    edits.push({ from: run.from, to: run.to, text: '' })
  }
  let source = map.source
  for (const edit of edits.sort((a, b) => b.from - a.from || b.to - a.to)) {
    source = source.slice(0, edit.from) + edit.text + source.slice(edit.to)
  }
  return source
}
