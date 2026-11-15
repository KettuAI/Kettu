// A device that draws tool calls folded gets their long outputs and inputs as digests in the pages
// it reads, which are most of their bytes; `sessions.entry` reads an entry whole when it opens one.

import type {
  DigestedThreadEntry,
  DigestedToolEntry,
  ThreadEntry,
  ToolContent,
  ToolContentDigest,
  ToolInputDigest,
} from '@shared/thread'

/** An input this long or shorter, in UTF-8 bytes, stays whole: nearly every command. */
export const DIGEST_INPUT_BYTES = 2 * 1024
/** A text output this long or shorter stays whole. */
export const DIGEST_OUTPUT_BYTES = 1024
/** A diff whose old and new text are together this long or shorter stays whole: most edits. */
export const DIGEST_DIFF_BYTES = 8 * 1024
/** The steps comparing a diff's lines may take, a few milliseconds, before its counts are null. */
export const DIFF_WORK = 2_000_000

/** The entries with each long tool output and input as a digest; the same entries otherwise. */
export function digestEntries<T extends { entries: ThreadEntry[] }>(
  page: T,
): Omit<T, 'entries'> & { entries: DigestedThreadEntry[] } {
  return { ...page, entries: page.entries.map(digestEntry) }
}

/** A tool call that waits for an answer stays whole, since its card shows what it asks about. */
export function digestEntry(entry: ThreadEntry): DigestedThreadEntry {
  if (entry.kind !== 'tool' || entry.permission !== null) return entry
  let content: (ToolContent | ToolContentDigest)[] | null = null
  entry.content.forEach((item, index) => {
    const digest = digestContent(item)
    if (digest) (content ??= [...entry.content])[index] = digest
  })
  const input = entry.rawInput === undefined ? null : digestInput(entry.rawInput)
  if (!content && !input) return entry
  const digested: DigestedToolEntry = { ...entry, content: content ?? entry.content }
  if (input) {
    delete digested.rawInput
    digested.rawInputDigest = input
  }
  return digested
}

function digestContent(item: ToolContent): ToolContentDigest | null {
  if (item.type === 'markdown') {
    const size = Buffer.byteLength(item.markdown)
    if (size <= DIGEST_OUTPUT_BYTES) return null
    return { type: 'digest', of: 'markdown', size, lines: lineCount(item.markdown) }
  }
  if (item.type === 'diff') {
    const size = Buffer.byteLength(item.oldText ?? '') + Buffer.byteLength(item.newText)
    if (size <= DIGEST_DIFF_BYTES) return null
    const { added, removed } = diffCounts(item.oldText, item.newText)
    return { type: 'digest', of: 'diff', path: item.path, size, added, removed }
  }
  return null
}

function digestInput(input: string): ToolInputDigest | null {
  const size = Buffer.byteLength(input)
  return size > DIGEST_INPUT_BYTES ? { size, lines: lineCount(input) } : null
}

/** A text's lines, a final line break ending the last rather than starting another. */
function lines(text: string): string[] {
  if (text === '') return []
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

function lineCount(text: string): number {
  if (text === '') return 0
  let count = text.endsWith('\n') ? 0 : 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}

/** The lines a change adds and removes; null for both when comparing them takes too long. */
export function diffCounts(
  oldText: string | null,
  newText: string,
): { added: number | null; removed: number | null } {
  const after = lines(newText)
  if (oldText === null) return { added: after.length, removed: 0 }
  const before = lines(oldText)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  const distance = editDistance(a, b)
  if (distance === null) return { added: null, removed: null }
  const common = (a.length + b.length - distance) / 2
  return { added: b.length - common, removed: a.length - common }
}

/**
 * The fewest lines to remove and add to turn `a` into `b`, by Myers' O(ND) algorithm; null past
 * `DIFF_WORK` steps. Node's `util.diff` would also do, but it keeps a copy of its frontier for
 * every step, so a rewritten file of a few thousand lines takes hundreds of megabytes, with no
 * bound on its time.
 */
function editDistance(a: readonly string[], b: readonly string[]): number | null {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return n + m
  const max = n + m
  const offset = max + 1
  // The furthest x reached on each diagonal k = x - y, at index offset + k.
  const reach = new Int32Array(2 * max + 3)
  let work = 0
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && reach[offset + k - 1]! < reach[offset + k + 1]!)
      const from = down ? reach[offset + k + 1]! : reach[offset + k - 1]! + 1
      let x = from
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      work += 1 + x - from
      reach[offset + k] = x
      if (x >= n && y >= m) return d
    }
    if (work > DIFF_WORK) return null
  }
  return max
}
