// A passage selected in a file of the Files pane, as the composer quotes it: where it lies in the
// file, then its text, so the agent gets that passage instead of the whole file.

import type { Text } from '@codemirror/state'
import { QUOTE_LIMIT, quoteBlock } from '@renderer/features/session/entries/reply-quote'

export interface FilePassage {
  /** The first and last line it covers, from 1; null for a passage of rendered Markdown. */
  lines: [number, number] | null
  text: string
}

/**
 * The passage `from`-`to` selects in `doc`, without the line breaks at its ends, and the lines it
 * covers. Null when it holds only white space, or is the whole file, which goes as the file.
 */
export function selectedPassage(doc: Text, from: number, to: number): FilePassage | null {
  if (from === 0 && to === doc.length) return null
  const raw = doc.sliceString(from, to, '\n')
  const head = /^\n*/.exec(raw)![0].length
  const tail = /\n*$/.exec(raw)![0].length
  // A line break the file mixes in stays in its line, as the editor keeps it.
  const text = raw.slice(head, raw.length - tail).replace(/\r+$/gm, '')
  if (!text.trim()) return null
  return { lines: [doc.lineAt(from).number + head, doc.lineAt(to).number - tail], text }
}

/** The quote of a passage of the file `path`, relative to the project, for the composer. */
export function fileQuote(path: string, { lines, text }: FilePassage): string {
  // Rendered Markdown is prose, quoted as a passage of a reply is.
  if (!lines) return `${inlineCode(path)}\n${quoteBlock(text)}`
  const [start, end] = lines
  const where = `${path}#L${start}${end > start ? `-${end}` : ''}`
  // Code keeps its lines and indentation only in a fence; a quote reads it as prose. The thread
  // numbers the fence's lines from `startLine`, as the file does, which needs a language before it.
  const body = clip(text)
  const fence = ticks(body, 3)
  const info = `${fenceLanguage(path) || 'text'} startLine=${start}`
  return `${inlineCode(where)}\n${fence}${info}\n${body}\n${fence}`
}

/** A passage over the quote limit, cut at the end of a line where it can be. */
function clip(text: string): string {
  if (text.length <= QUOTE_LIMIT) return text
  const cut = text.lastIndexOf('\n', QUOTE_LIMIT)
  return cut > 0 ? `${text.slice(0, cut)}\n…` : `${text.slice(0, QUOTE_LIMIT)}…`
}

/** Backticks one longer than the longest run in `text`, so none of it closes them. */
function ticks(text: string, least: number): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return '`'.repeat(Math.max(least, longest + 1))
}

function inlineCode(text: string): string {
  const mark = ticks(text, 1)
  const pad = text.includes('`') ? ' ' : ''
  return `${mark}${pad}${text}${pad}${mark}`
}

/**
 * The fence's language, by the file's extension as code blocks name most languages; none for the
 * languages the thread draws instead of showing their code.
 */
function fenceLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (extension === 'svg') return 'xml'
  return /^[a-z0-9+#-]+$/.test(extension) && extension !== 'mermaid' && extension !== 'math'
    ? extension
    : ''
}
