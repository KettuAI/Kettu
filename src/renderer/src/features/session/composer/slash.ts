import { findSkillTokens } from '@shared/slash'
import { isSkillCommand, type SlashCommand } from '@shared/thread'
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

/** A slash token that was just chosen from the completion list, suppressed from reopening it. */
export interface CompletedSlash {
  /** Where the `/` of the chosen token starts. */
  start: number
  /** The chosen command or skill name without its leading `/`. */
  name: string
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
 * Whether a recently chosen slash token still stands at its position and the caret has not moved
 * into a different `/word`.
 */
export function keepsCompletedSlash(
  text: string,
  completed: CompletedSlash | null,
  rawSlash: Slash | null,
): boolean {
  if (!completed) return false
  if (rawSlash && rawSlash.start !== completed.start) return false
  const token = `/${completed.name}`
  return text.startsWith(token, completed.start)
}

/**
 * The `/word` that should open the slash completion popover, or null when the caret sits on a
 * recently chosen token or on the trailing-whitespace boundary of an already-completed skill or
 * leading command (such as `/code-review| `).
 */
export function slashPopoverAt(
  text: string,
  caret: number | null,
  commands: readonly SlashCommand[],
  completed: CompletedSlash | null = null,
): Slash | null {
  const found = slashAt(text, caret)
  if (!found || caret === null) return null
  if (completed && found.start === completed.start && found.query === completed.name) {
    return null
  }
  const end = found.start + 1 + found.query.length
  if (caret === end && end < text.length && /\s/.test(text[end]!)) {
    const exact = commands.find((command) => command.name === found.query)
    if (exact && (isSkillCommand(exact) || found.start === 0)) return null
  }
  return found
}

/**
 * The text with an exclusive command at its start in place of the word `slash` was typing, and
 * where the caret goes: after the command when the word led the text, else where the word was.
 * Only a leading command whose name is in `names` is replaced, so stacked skills stay intact.
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

/**
 * The text with a stackable skill inserted inline at the word `slash` was typing, leaving any
 * earlier skills or leading command untouched, and the caret after the trailing space.
 */
export function insertSkill(
  text: string,
  slash: Slash,
  name: string,
): { text: string; caret: number } {
  const end = slash.start + 1 + slash.query.length
  const before = `${text.slice(0, slash.start)}/${name}`
  const after = text.slice(end)
  const next = after.startsWith(' ') ? `${before}${after}` : `${before} ${after}`
  return { text: next, caret: before.length + 1 }
}

/**
 * Applies a chosen slash entry: stackable skills insert inline at `slash`, while exclusive
 * commands move to position 0 and replace only another leading exclusive command.
 */
export function applySlashChoice(
  text: string,
  slash: Slash,
  chosen: SlashCommand,
  commands: readonly SlashCommand[],
): { text: string; caret: number } {
  if (isSkillCommand(chosen)) return insertSkill(text, slash, chosen.name)
  const exclusive = commands.filter((c) => !isSkillCommand(c)).map((c) => c.name)
  return placeCommand(text, slash, chosen.name, exclusive)
}

export interface ActiveSlashItems {
  /** The leading exclusive command at position 0, if any. */
  command: SlashCommand | null
  /** Distinct stackable skills referenced anywhere in the message, in order of first appearance. */
  skills: SlashCommand[]
}

/** Resolves the leading exclusive command and all active skills currently present in `text`. */
export function activeSlashItems(
  text: string,
  commands: readonly SlashCommand[],
): ActiveSlashItems {
  const exclusive: SlashCommand[] = []
  const skillByName = new Map<string, SlashCommand>()
  for (const command of commands) {
    if (isSkillCommand(command)) {
      if (!skillByName.has(command.name)) skillByName.set(command.name, command)
    } else {
      exclusive.push(command)
    }
  }
  const led = leadingCommand(
    text,
    exclusive.map((c) => c.name),
  )
  const command = led ? (exclusive.find((c) => c.name === text.slice(1, led)) ?? null) : null
  const skills: SlashCommand[] = []
  if (skillByName.size > 0) {
    const seen = new Set<string>()
    for (const token of findSkillTokens(text, [...skillByName.keys()])) {
      if (token.from < led || seen.has(token.name)) continue
      seen.add(token.name)
      const entry = skillByName.get(token.name)
      if (entry) skills.push(entry)
    }
  }
  return { command, skills }
}
