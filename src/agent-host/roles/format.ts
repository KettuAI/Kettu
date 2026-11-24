// A role of Kettu's as a Markdown file: front matter with its name, what it is for, the agent,
// model and effort it suggests and the skills and MCP servers it needs, then the instructions
// the agent is given.
//
//   ---
//   name: Release manager
//   description: Cuts a release
//   agent: claude-code
//   model: opus
//   effort: high
//   skills: [changelog-writer]
//   mcp: [github]
//   ---
//   You prepare releases. Never publish without asking.

import type { RoleSuggests } from '@shared/agent-host'
import { names, oneLine, readFrontMatter, type CommandNeeds } from '../commands/format'

export interface RoleDefinition {
  /** The name its own file gives it, when it gives one. */
  title?: string
  description: string
  suggests: RoleSuggests
  /** The skills and MCP servers it needs, by the names the Marketplace keeps them under. */
  needs: CommandNeeds
  /** The instructions for the agent. */
  body: string
}

/** A file read, or why it does not read. */
export type ParsedRole = { ok: true; role: RoleDefinition } | { ok: false; reason: string }

/** Instructions go into every session's system prompt and the sessions index, so they stay short. */
export const ROLE_FILE_BYTES = 32 * 1024
const TITLE_CHARS = 100
const SUGGESTION_CHARS = 200

function suggestion(data: Record<string, unknown>, key: keyof RoleSuggests): string | undefined {
  const value = data[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} is not text`)
  const text = oneLine(value, SUGGESTION_CHARS)
  return text === '' ? undefined : text
}

/** Reads a role's file; `ok` false with the reason when it does not read. */
export function parseRole(text: string): ParsedRole {
  const read = readFrontMatter(text)
  if ('reason' in read) return { ok: false, reason: read.reason }
  const { data } = read
  for (const key of ['name', 'description'] as const) {
    if (data[key] !== undefined && typeof data[key] !== 'string') {
      return { ok: false, reason: `${key} is not text` }
    }
  }
  const suggests: RoleSuggests = {}
  try {
    for (const key of ['agent', 'model', 'effort'] as const) {
      const value = suggestion(data, key)
      if (value !== undefined) suggests[key] = value
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  const skills = names(data.skills, 'skills')
  if (typeof skills === 'string') return { ok: false, reason: skills }
  const mcp = names(data.mcp, 'mcp')
  if (typeof mcp === 'string') return { ok: false, reason: mcp }
  const body = read.body.trim()
  if (body === '') return { ok: false, reason: 'it has no instructions' }
  const title = oneLine(typeof data.name === 'string' ? data.name : '', TITLE_CHARS)
  return {
    ok: true,
    role: {
      ...(title === '' ? {} : { title }),
      description: oneLine(typeof data.description === 'string' ? data.description : '', 500),
      suggests,
      needs: { skills, mcp },
      body,
    },
  }
}

/** A role's instructions as the block an agent is given them in, marked as Kettu's own. */
export function roleBlock(title: string, instructions: string): string {
  return `<kettu-role name="${title.replace(/["<>\r\n]/g, ' ').trim()}">\n${instructions}\n</kettu-role>`
}
