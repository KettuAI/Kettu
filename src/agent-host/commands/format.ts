// A command of Kettu's as a Markdown file: front matter with its description, the arguments it
// takes and the skills and MCP servers it needs, then a prompt with argument placeholders.
//
//   ---
//   description: Review a file
//   arguments:
//     - name: file
//       help: The file to review
//     - name: focus
//       help: What to look at first
//       required: false
//   skills: [code-review]
//   mcp: [github]
//   ---
//   Review {{file}}. {{focus}}
//
// `{{name}}` is an argument's value and `{{arguments}}` everything typed after the command.

import { parse } from 'yaml'

/** The skills and MCP servers a command names, by the names the Marketplace keeps them under. */
export interface CommandNeeds {
  skills: string[]
  mcp: string[]
}

export interface CommandArgument {
  name: string
  help: string
  required: boolean
}

export interface CommandDefinition {
  description: string
  arguments: CommandArgument[]
  /** The skills and MCP servers it needs, by the names the Marketplace keeps them under. */
  skills: string[]
  mcp: string[]
  /** The prompt, with its placeholders. */
  body: string
}

/** A file read, or why it does not read. */
export type ParsedCommand = { ok: true; command: CommandDefinition } | { ok: false; reason: string }

export const COMMAND_FILE_BYTES = 256 * 1024
const MAX_ARGUMENTS = 10
const MAX_NEEDS = 20
const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
/** The placeholder for everything typed after the command. */
const WHOLE = 'arguments'
const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const oneLine = (value: string, max: number): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, max)

/** A list of names from front matter, or what is wrong with it. */
export function names(value: unknown, field: string): string[] | string {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_NEEDS) return `${field} is not a short list`
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > 200) {
      return `${field} holds something that is not a name`
    }
    if (!out.includes(item.trim())) out.push(item.trim())
  }
  return out
}

function argumentsOf(value: unknown): CommandArgument[] | string {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    return `arguments is not a list of at most ${MAX_ARGUMENTS}`
  }
  const out: CommandArgument[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || !ARGUMENT_NAME.test(item.name)) {
      return 'an argument has no name of letters, digits, - and _'
    }
    if (item.name === WHOLE || out.some((argument) => argument.name === item.name)) {
      return `the argument name ${item.name} is taken`
    }
    if (item.help !== undefined && typeof item.help !== 'string') {
      return `the help of ${item.name} is not text`
    }
    if (item.required !== undefined && typeof item.required !== 'boolean') {
      return `required of ${item.name} is not true or false`
    }
    out.push({
      name: item.name,
      help: oneLine(item.help ?? '', 300),
      required: item.required !== false,
    })
  }
  return out
}

/** A Markdown file's front matter as a map, and the text after it; the reason when it is no map. */
export function readFrontMatter(
  text: string,
): { data: Record<string, unknown>; body: string } | { reason: string } {
  let data: unknown = {}
  let body = text.replace(/^\uFEFF/, '')
  const front = FRONT_MATTER.exec(text)
  if (front) {
    try {
      data = parse(front[1]!) ?? {}
    } catch (error) {
      return { reason: `the front matter is not YAML: ${(error as Error).message}` }
    }
    body = text.slice(front[0].length)
  }
  if (!isRecord(data)) return { reason: 'the front matter is not a map' }
  return { data, body }
}

/** Reads a command's file; `ok` false with the reason when it does not read. */
export function parseCommand(text: string): ParsedCommand {
  const read = readFrontMatter(text)
  if ('reason' in read) return { ok: false, reason: read.reason }
  const { data } = read
  let { body } = read
  if (data.description !== undefined && typeof data.description !== 'string') {
    return { ok: false, reason: 'description is not text' }
  }
  const args = argumentsOf(data.arguments)
  if (typeof args === 'string') return { ok: false, reason: args }
  const skills = names(data.skills, 'skills')
  if (typeof skills === 'string') return { ok: false, reason: skills }
  const mcp = names(data.mcp, 'mcp')
  if (typeof mcp === 'string') return { ok: false, reason: mcp }
  body = body.trim()
  if (body === '') return { ok: false, reason: 'it has no prompt' }
  return {
    ok: true,
    command: {
      description: oneLine(typeof data.description === 'string' ? data.description : '', 500),
      arguments: args,
      skills,
      mcp,
      body,
    },
  }
}

/** The arguments as a hint beside the command: `<file> [focus]`. */
export function inputHint(command: CommandDefinition): string | undefined {
  if (command.arguments.length === 0) return undefined
  return command.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ')
}

/**
 * What was typed after a command as `count` values: each of the first ones a word, or a quoted
 * phrase, and the last whatever remains, as typed.
 */
export function splitArguments(typed: string, count: number): string[] {
  const rest = typed.trim()
  const values: string[] = []
  let at = 0
  while (values.length < count - 1 && at < rest.length) {
    while (at < rest.length && /\s/.test(rest[at]!)) at++
    if (at >= rest.length) break
    const quote = rest[at] === '"' || rest[at] === "'" ? rest[at] : null
    const close = quote ? rest.indexOf(quote, at + 1) : -1
    if (quote && close !== -1) {
      values.push(rest.slice(at + 1, close))
      at = close + 1
      continue
    }
    let end = at
    while (end < rest.length && !/\s/.test(rest[end]!)) end++
    values.push(rest.slice(at, end))
    at = end
  }
  if (count > 0 && at < rest.length) values.push(rest.slice(at).trim())
  return values
}

/** The prompt with the arguments filled in, or the required arguments that have no value. */
export function fillCommand(
  command: CommandDefinition,
  typed: string,
): { ok: true; text: string } | { ok: false; missing: string[] } {
  const values = splitArguments(typed, command.arguments.length)
  const missing = command.arguments.filter((a, i) => a.required && !values[i]).map((a) => a.name)
  if (missing.length > 0) return { ok: false, missing }
  const byName = new Map<string, string>([[WHOLE, typed.trim()]])
  command.arguments.forEach((a, i) => byName.set(a.name, values[i] ?? ''))
  // One pass, so a value that holds a placeholder is not filled in again.
  const text = command.body.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g,
    (whole, name: string) => byName.get(name) ?? whole,
  )
  return { ok: true, text }
}
