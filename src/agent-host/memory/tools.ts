// The memory tools of the artifacts service: an agent reads Kettu's memory and writes its
// session's project memory, which the thread shows with Undo. Global memory is about the user, so
// an agent only proposes a write there and the user decides in the thread.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AgentId } from '@shared/agents'
import {
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_ID,
  MEMORY_PROPOSALS_WAITING,
  MEMORY_TITLE_CHARS,
  type MemoryAction,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryLayer,
  type MemoryScope,
} from '@shared/memory'
import type { Caller } from '../artifacts/tools'
import { MemoryError } from './errors'
import type { MemoryService } from './service'

export const LIST_MEMORIES_TOOL = 'list_memories'
export const READ_MEMORY_TOOL = 'read_memory'
export const REMEMBER_TOOL = 'remember'
export const UPDATE_MEMORY_TOOL = 'update_memory'
export const FORGET_MEMORY_TOOL = 'forget_memory'

/** Every memory tool, for the agents that allow them without asking. */
export const MEMORY_TOOL_NAMES = [
  LIST_MEMORIES_TOOL,
  READ_MEMORY_TOOL,
  REMEMBER_TOOL,
  UPDATE_MEMORY_TOOL,
  FORGET_MEMORY_TOOL,
] as const

export function isMemoryToolName(name: string): boolean {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name)
}

export const MEMORY_INSTRUCTIONS =
  `Kettu keeps memory across sessions and agents, and the session starts with its index. ` +
  `${READ_MEMORY_TOOL} reads an entry in full and ${LIST_MEMORIES_TOOL} lists them all. Save ` +
  `what will help a later session with ${REMEMBER_TOOL}, one fact per entry: the user's ` +
  'preferences and corrections, and decisions and facts about the project its files do not ' +
  `show. Prefer ${UPDATE_MEMORY_TOOL} to a near copy, and ${FORGET_MEMORY_TOOL} what turned out ` +
  'wrong. Project memory is the default; global memory is only about the user, and the user ' +
  'approves each global write. Never save secrets or what the repository already records.'

const LAYER = {
  type: 'string',
  enum: ['project', 'global'],
  description:
    "project: this project's memory. global: memory about the user, used in every project.",
}
const ID = {
  type: 'string',
  pattern: MEMORY_ID.source,
  maxLength: 64,
  description: 'The entry id, as the index or list_memories shows it in brackets.',
}
const TITLE = {
  type: 'string',
  minLength: 1,
  maxLength: MEMORY_TITLE_CHARS,
  description: 'A short name for the fact.',
}
const DESCRIPTION = {
  type: 'string',
  maxLength: MEMORY_DESCRIPTION_CHARS,
  description: "One line, the entry's line in the index: enough to tell when it matters.",
}
const BODY = {
  type: 'string',
  maxLength: MEMORY_BODY_CHARS,
  description: 'The fact in Markdown, with why it holds and how to apply it.',
}

export const MEMORY_TOOLS: Tool[] = [
  {
    name: LIST_MEMORIES_TOOL,
    title: 'List memories',
    description:
      "Lists the entries of Kettu's memory with their ids, when the index the session started " +
      'with says some were left out or may be out of date.',
    inputSchema: {
      type: 'object',
      properties: { layer: { ...LAYER, description: 'One layer; both when left out.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: READ_MEMORY_TOOL,
    title: 'Read a memory',
    description:
      "Reads an entry of Kettu's memory in full, when its line in the index bears on the task.",
    inputSchema: {
      type: 'object',
      properties: { layer: LAYER, id: ID },
      required: ['layer', 'id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: REMEMBER_TOOL,
    title: 'Remember',
    description:
      'Saves one fact that will help a later session: a preference or correction of the user, or ' +
      'a decision or non-obvious fact about the project that its files do not show. Project ' +
      'memory is saved at once and the user can undo it. Global memory is only for things about ' +
      'the user that hold in every project; it is proposed to the user, who decides. Never save ' +
      'secrets or what the repository or its git history already records.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { ...LAYER, default: 'project' },
        title: TITLE,
        description: DESCRIPTION,
        body: BODY,
      },
      required: ['title', 'description', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: UPDATE_MEMORY_TOOL,
    title: 'Update a memory',
    description:
      "Changes an entry of Kettu's memory, rather than adding a near copy. Give only the fields " +
      'that change. A global entry is changed only once the user accepts.',
    inputSchema: {
      type: 'object',
      properties: { layer: LAYER, id: ID, title: TITLE, description: DESCRIPTION, body: BODY },
      required: ['layer', 'id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: FORGET_MEMORY_TOOL,
    title: 'Forget a memory',
    description:
      "Removes an entry of Kettu's memory that turned out wrong or no longer holds. A project " +
      'entry can be undone by the user; a global one is removed only once the user accepts.',
    inputSchema: {
      type: 'object',
      properties: { layer: LAYER, id: ID },
      required: ['layer', 'id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

export interface MemoryToolsDeps {
  service: MemoryService
  /** The project of the caller's session, null for a session without one. */
  projectOf(caller: Caller): string | null
  /** A project write happened: the host adds the thread row. */
  written(
    sessionId: string,
    write: {
      layer: 'project'
      action: MemoryAction
      memoryId: string
      title: string
      undo: string
    },
  ): void
  /**
   * A global write is proposed: the host adds the card, unless the session has no thread
   * (`closed`) or enough proposals already wait in it (`full`).
   */
  proposed(
    sessionId: string,
    proposal: {
      action: MemoryAction
      memoryId: string | null
      title: string
      draft: MemoryDraft | null
    },
  ): 'added' | 'closed' | 'full'
  agentOf(sessionId: string): AgentId | null
}

type Args = Record<string, unknown>

const ALLOWED: Record<string, readonly string[]> = {
  [LIST_MEMORIES_TOOL]: ['layer'],
  [READ_MEMORY_TOOL]: ['layer', 'id'],
  [REMEMBER_TOOL]: ['layer', 'title', 'description', 'body'],
  [UPDATE_MEMORY_TOOL]: ['layer', 'id', 'title', 'description', 'body'],
  [FORGET_MEMORY_TOOL]: ['layer', 'id'],
}

function invalid(message: string): MemoryError {
  return new MemoryError('invalid', message)
}

function args(name: string, input: unknown): Args {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('The arguments must be an object.')
  }
  const unknown = Object.keys(input).find((key) => !ALLOWED[name]!.includes(key))
  if (unknown !== undefined) throw invalid(`Unknown argument ${unknown}.`)
  return input as Args
}

function layerOf(o: Args, fallback: MemoryLayer | null): MemoryLayer | null {
  if (o.layer === undefined) return fallback
  if (o.layer !== 'project' && o.layer !== 'global') {
    throw invalid('layer must be project or global.')
  }
  return o.layer
}

function idOf(o: Args): string {
  if (typeof o.id !== 'string' || !MEMORY_ID.test(o.id)) {
    throw invalid(`id must be an entry id as ${LIST_MEMORIES_TOOL} shows it, such as run-tests.`)
  }
  return o.id
}

function field(o: Args, key: string, required: boolean): string | undefined {
  const value = o[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw invalid(`${key} must be a string.`)
  return value
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function listed(heading: string, entries: MemoryEntry[]): string[] {
  if (entries.length === 0) return [heading, '(none yet)']
  return [
    heading,
    ...entries.map((entry) => {
      const text = entry.description === '' ? entry.title : `${entry.title}: ${entry.description}`
      return `- [${entry.id}] ${text} (updated ${day(entry.updatedAt)})`
    }),
  ]
}

function done(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

const PROPOSED =
  'nothing is saved unless they accept. Carry on with your task; do not propose it again.'

const NO_PROJECT =
  'This session has no project, so it has no project memory. Use global memory only for things ' +
  'about the user that hold in every project.'

export class MemoryTools {
  constructor(private readonly deps: MemoryToolsDeps) {}

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (!isMemoryToolName(name)) throw new Error(`Unknown tool ${name}`)
    try {
      if (!this.deps.service.enabled) {
        throw new MemoryError(
          'off',
          "Kettu's memory is turned off. Do not use the memory tools in this session.",
        )
      }
      const o = args(name, input)
      switch (name) {
        case LIST_MEMORIES_TOOL:
          return await this.list(caller, layerOf(o, null))
        case READ_MEMORY_TOOL:
          return await this.read(caller, layerOf(o, null), idOf(o))
        case REMEMBER_TOOL:
          return await this.remember(caller, layerOf(o, 'project')!, {
            title: field(o, 'title', true)!,
            description: field(o, 'description', true)!,
            body: field(o, 'body', true)!,
          })
        case UPDATE_MEMORY_TOOL:
          return await this.update(caller, layerOf(o, null), idOf(o), {
            title: field(o, 'title', false),
            description: field(o, 'description', false),
            body: field(o, 'body', false),
          })
        default:
          return await this.forget(caller, layerOf(o, null), idOf(o))
      }
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error
      return {
        content: [{ type: 'text', text: error.message }],
        structuredContent: { code: error.code, message: error.message },
        isError: true,
      }
    }
  }

  /** The scope of a layer for the caller: its own project's memory, or global memory. */
  private scope(caller: Caller, layer: MemoryLayer | null): MemoryScope {
    if (layer === null) throw invalid('layer must be project or global.')
    if (layer === 'global') return { layer: 'global' }
    const project = this.deps.projectOf(caller)
    if (project === null) throw invalid(NO_PROJECT)
    return { layer: 'project', project }
  }

  private async list(caller: Caller, layer: MemoryLayer | null): Promise<CallToolResult> {
    const project = this.deps.projectOf(caller)
    if (layer === 'project' && project === null) throw invalid(NO_PROJECT)
    const lines: string[] = []
    if (layer !== 'global' && project !== null) {
      lines.push(
        ...listed('Project memory:', await this.deps.service.list({ layer: 'project', project })),
      )
    }
    if (layer !== 'project') {
      lines.push(
        ...listed(
          'Global memory (about the user):',
          await this.deps.service.list({ layer: 'global' }),
        ),
      )
    }
    return done(lines.join('\n'))
  }

  private async existing(scope: MemoryScope, id: string): Promise<MemoryEntry> {
    const entry = await this.deps.service.get(scope, id)
    if (entry) return entry
    throw new MemoryError(
      'not_found',
      `No ${scope.layer} memory entry has the id ${id}. ${LIST_MEMORIES_TOOL} shows the ids.`,
    )
  }

  private async read(
    caller: Caller,
    layer: MemoryLayer | null,
    id: string,
  ): Promise<CallToolResult> {
    const entry = await this.existing(this.scope(caller, layer), id)
    const by = entry.source.agentId ?? 'the user'
    const lines = [entry.title]
    if (entry.description !== '') lines.push(entry.description)
    lines.push(`Updated ${day(entry.updatedAt)} by ${by}.`, '', entry.body)
    return done(lines.join('\n'))
  }

  private by(caller: Caller) {
    return { agentId: this.deps.agentOf(caller.sessionId), sessionId: caller.sessionId }
  }

  private propose(
    caller: Caller,
    proposal: {
      action: MemoryAction
      memoryId: string | null
      title: string
      draft: MemoryDraft | null
    },
  ): CallToolResult {
    const outcome = this.deps.proposed(caller.sessionId, proposal)
    if (outcome === 'closed') {
      throw new MemoryError('not_found', 'This session is not open, so it cannot propose a write.')
    }
    if (outcome === 'full') {
      throw new MemoryError(
        'full',
        `${MEMORY_PROPOSALS_WAITING} proposals already wait for the user in this session. Propose ` +
          'more only after they answer.',
      )
    }
    return done(`Proposed to the user for global memory. They decide in the thread; ${PROPOSED}`)
  }

  private async remember(
    caller: Caller,
    layer: MemoryLayer,
    draft: MemoryDraft,
  ): Promise<CallToolResult> {
    const scope = this.scope(caller, layer)
    if (scope.layer === 'global') {
      const checked = await this.deps.service.check(scope, null, draft)
      return this.propose(caller, {
        action: 'remember',
        memoryId: null,
        title: checked.title,
        draft: checked,
      })
    }
    const { entry, undo } = await this.deps.service.save(scope, null, draft, this.by(caller))
    this.deps.written(caller.sessionId, {
      layer: 'project',
      action: 'remember',
      memoryId: entry.id,
      title: entry.title,
      undo,
    })
    return done(`Saved to project memory as ${entry.id}. The user can undo it from the thread.`)
  }

  private async update(
    caller: Caller,
    layer: MemoryLayer | null,
    id: string,
    change: Partial<MemoryDraft>,
  ): Promise<CallToolResult> {
    if (
      change.title === undefined &&
      change.description === undefined &&
      change.body === undefined
    ) {
      throw invalid('Give at least one of title, description and body.')
    }
    const scope = this.scope(caller, layer)
    const entry = await this.existing(scope, id)
    const draft: MemoryDraft = {
      title: change.title ?? entry.title,
      description: change.description ?? entry.description,
      body: change.body ?? entry.body,
    }
    if (scope.layer === 'global') {
      const checked = await this.deps.service.check(scope, id, draft)
      return this.propose(caller, {
        action: 'update',
        memoryId: id,
        title: checked.title,
        draft: checked,
      })
    }
    const saved = await this.deps.service.save(scope, id, draft, this.by(caller))
    this.deps.written(caller.sessionId, {
      layer: 'project',
      action: 'update',
      memoryId: id,
      title: saved.entry.title,
      undo: saved.undo,
    })
    return done(`Updated ${id} in project memory. The user can undo it from the thread.`)
  }

  private async forget(
    caller: Caller,
    layer: MemoryLayer | null,
    id: string,
  ): Promise<CallToolResult> {
    const scope = this.scope(caller, layer)
    if (scope.layer === 'global') {
      const entry = await this.existing(scope, id)
      return this.propose(caller, {
        action: 'forget',
        memoryId: id,
        title: entry.title,
        draft: null,
      })
    }
    const { undo, title } = await this.deps.service.remove(scope, id, this.by(caller))
    this.deps.written(caller.sessionId, {
      layer: 'project',
      action: 'forget',
      memoryId: id,
      title,
      undo,
    })
    return done(`Removed ${id} from project memory. The user can undo it from the thread.`)
  }
}
