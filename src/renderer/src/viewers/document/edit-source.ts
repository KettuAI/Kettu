// A block's text typed in place, back into its Markdown: each text node the block rendered is
// found in the block's source when editing starts, and the words typed into it replace that stretch
// of source, so links, emphasis and code around them stay as they were.

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

/** Finds the block's rendered words in its source, in order. */
export function mapSource(root: Element, source: string): SourceMap {
  const runs: Run[] = []
  let cursor = 0
  for (const node of textNodes(root)) {
    const text = node.data
    const code = !!node.parentElement?.closest('code, pre')
    if (text.trim() === '') {
      runs.push({ node, from: null, to: cursor, text, code })
      continue
    }
    const at = source.indexOf(text, cursor)
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
