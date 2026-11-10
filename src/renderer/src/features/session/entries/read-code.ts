// How a tool's text result reads in its step's card.

import { basename } from '@renderer/lib/format'

const FENCE = /^(`{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/
// Claude Code numbers each line of a file it reads: the number, then a tab or an arrow.
const NUMBERED = /^\s*(\d+)(?:\t|\u2192)(.*)$/

/** The text inside a result that is one fenced block, else the result as it is. */
export function fenceBody(markdown: string): string {
  return FENCE.exec(markdown.trim())?.[2] ?? markdown
}

/**
 * A file read whose result numbers every line, as one block in the file's language that numbers
 * its lines itself from the first one read, so the card shows one column of numbers. Null when
 * the result is not one such block.
 */
export function numberedRead(markdown: string, path: string | undefined): string | null {
  const body = FENCE.exec(markdown.trim())?.[2]
  if (body === undefined) return null
  let start = 0
  const code: string[] = []
  for (const [i, line] of body.split('\n').entries()) {
    const match = NUMBERED.exec(line)
    if (!match) return null
    const n = Number(match[1])
    if (i === 0) start = n
    else if (n !== start + i) return null
    code.push(match[2]!)
  }
  const name = path ? basename(path) : ''
  const language = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  // A fence longer than any run of backticks in the code, so none of them closes it.
  let fence = '```'
  for (const [run] of code.join('\n').matchAll(/`{3,}/g)) {
    while (run.length >= fence.length) fence += '`'
  }
  return `${fence}${language} startLine=${start}\n${code.join('\n')}\n${fence}`
}
