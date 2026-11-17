import type { SlashCommand } from '@shared/thread'
import { startsWord } from './trigger'

/** The commands whose name holds the query, those that start with it first, each in the agent's order. */
export function orderSlashMatches(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.toLowerCase()
  const starts: SlashCommand[] = []
  const contains: SlashCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) starts.push(command)
    else if (name.includes(needle)) contains.push(command)
  }
  return [...starts, ...contains]
}

/**
 * The length of the command the text starts with: `/` and one of the names exactly, case included,
 * since the agent receives the text as typed, then a space, a line break or nothing. 0 for none.
 */
export function leadingCommand(text: string, names: readonly string[]): number {
  const match = /^\/(\S+)(?=[ \n]|$)/.exec(text)
  return match && names.includes(match[1]) ? match[0].length : 0
}

export interface Slash {
  /** Where the `/` is. */
  start: number
  /** What follows the `/` up to the end of its word. */
  query: string
}

/**
 * The `/word` the caret is in: the nearest `/` before it in its word that starts a word, with the
 * rest of the word as the query; null otherwise.
 */
export function slashAt(text: string, caret: number | null): Slash | null {
  if (caret === null || caret > text.length) return null
  for (let at = caret - 1; at >= 0 && !/\s/.test(text[at]!); at--) {
    if (text[at] !== '/' || !startsWord(text, at)) continue
    let end = caret
    while (end < text.length && !/\s/.test(text[end]!)) end++
    return { start: at, query: text.slice(at + 1, end) }
  }
  return null
}

/**
 * The text with the command at its start in place of the word `slash` was typing, and where the
 * caret goes: after the command when the word led the text, else where the word was. A command
 * that led the text before is replaced, since only one is read.
 */
export function placeCommand(
  text: string,
  slash: Slash,
  name: string,
  names: readonly string[],
): { text: string; caret: number } {
  const end = slash.start + 1 + slash.query.length
  const head = `/${name} `
  if (slash.start === 0) {
    const after = text.slice(end)
    return { text: `${head}${after.startsWith(' ') ? after.slice(1) : after}`, caret: head.length }
  }
  const before = text.slice(0, slash.start)
  const after = text.slice(end)
  let rest = before + (before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after)
  let caret = before.length
  const led = leadingCommand(rest, names)
  if (led) {
    const drop = rest[led] === ' ' ? led + 1 : led
    rest = rest.slice(drop)
    caret -= drop
  }
  const blank = rest.length - rest.trimStart().length
  return { text: `${head}${rest.slice(blank)}`, caret: head.length + Math.max(0, caret - blank) }
}
