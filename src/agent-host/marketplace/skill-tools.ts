// The skill tools of Kettu's MCP service, for a session whose agent loads no skill folders: one
// lists the skills the session was given, one reads a skill's SKILL.md and says where its folder is.

import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { SKILL_NAME } from '@shared/marketplace'
import { harnessOf, type AgentId } from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import { SKILL_FILE, SKILL_MD_BYTES } from './skill-catalog'

export const LIST_SKILLS = 'list_skills'
export const READ_SKILL = 'read_skill'
export const SKILL_TOOL_NAMES = [LIST_SKILLS, READ_SKILL] as const

/** The harnesses that load the skill folders Kettu hands them. */
const FOLDER_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex', 'opencode', 'pi'])

/** How an agent gets the skills Kettu keeps: folders it loads itself, or Kettu's skill tools. */
export function skillRoute(agentId: AgentId): 'folder' | 'tools' {
  return FOLDER_HARNESSES.has(harnessOf(agentId)) ? 'folder' : 'tools'
}

/**
 * Whether the agent gets the skills turned on for it. The skill tools are on Kettu's server, so an
 * agent that reads skills with them gets none while that server is off for it.
 */
export function takesSkills(agentId: AgentId, kettuOn: boolean): boolean {
  return skillRoute(agentId) === 'folder' || kettuOn
}

/** A skill a session may use: its folder holds its SKILL.md. */
export interface SessionSkill {
  name: string
  description: string
  dir: string
}

export interface SkillToolsDeps {
  /** The skills given to the session; null for a session whose agent loads skill folders itself. */
  of(sessionId: string): readonly SessionSkill[] | null
}

export const SKILL_TOOLS: Tool[] = [
  {
    name: LIST_SKILLS,
    title: 'List skills',
    description:
      'Lists the skills the user installed for you, each with its name and a description that ' +
      'says when to use it. Call it at the start of a task; when a skill fits the task, read it ' +
      `with ${READ_SKILL} before you start.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: READ_SKILL,
    title: 'Read a skill',
    description:
      `Returns the instructions of a skill ${LIST_SKILLS} names, its SKILL.md, and the absolute ` +
      'path of its folder. Follow the instructions; read the other files they name from that ' +
      'folder yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `A skill's name, as ${LIST_SKILLS} gives it.` },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

export function isSkillToolName(name: string): boolean {
  return (SKILL_TOOL_NAMES as readonly string[]).includes(name)
}

function refuse(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code: 'invalid', message },
    isError: true,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SkillTools {
  constructor(private readonly deps: SkillToolsDeps) {}

  /** Whether the session gets the tools: its agent loads no skill folders. */
  listed(sessionId: string): boolean {
    return this.deps.of(sessionId) !== null
  }

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    const skills = this.deps.of(caller.sessionId)
    if (skills === null) return refuse('This session loads its skills itself.')
    const o = input ?? {}
    if (!isObject(o)) return refuse('The arguments must be an object.')
    if (name === LIST_SKILLS) {
      const extra = Object.keys(o)[0]
      if (extra !== undefined) return refuse(`Unknown argument ${extra}.`)
      const list = skills.map((skill) => ({ name: skill.name, description: skill.description }))
      const text =
        list.length === 0
          ? 'No skills are installed for you.'
          : list.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
      return { content: [{ type: 'text', text }], structuredContent: { skills: list } }
    }
    const extra = Object.keys(o).find((key) => key !== 'name')
    if (extra !== undefined) return refuse(`Unknown argument ${extra}.`)
    // The folder comes from the session's own list, never from the name the agent sends.
    const skill = skills.find((kept) => kept.name === o.name)
    if (!skill || !SKILL_NAME.test(skill.name) || path.basename(skill.dir) !== skill.name) {
      const names = skills.map((kept) => kept.name).join(', ')
      return refuse(
        names === '' ? 'No skills are installed for you.' : `name must be one of ${names}.`,
      )
    }
    const file = path.join(skill.dir, SKILL_FILE)
    let text: string
    try {
      // A link could name a file outside the skill's folder.
      const info = await lstat(file)
      if (!info.isFile()) return refuse(`${skill.name} has no ${SKILL_FILE} to read.`)
      if (info.size > SKILL_MD_BYTES) {
        return refuse(`${skill.name}'s ${SKILL_FILE} is too large to return; read ${file}.`)
      }
      text = await readFile(file, 'utf8')
    } catch {
      return refuse(`${skill.name} has no ${SKILL_FILE} to read.`)
    }
    return {
      content: [{ type: 'text', text: `Skill folder: ${skill.dir}\n\n${text}` }],
      structuredContent: { name: skill.name, folder: skill.dir, text },
    }
  }
}
