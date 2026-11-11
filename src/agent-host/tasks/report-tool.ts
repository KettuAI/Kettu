// The task tools of Kettu's MCP service: the report a node's agent hands in, and the tool any
// agent saves a new SOP with. The tools only check the call's shape and who makes it; the task
// engine checks a report against the node and moves the task on, and the library checks an SOP.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { DOCUMENT_CHARS, NOTE_CHARS, SOP_FILE_CHARS } from '@shared/tasks'
import type { Caller } from '../artifacts/tools'
import { HostError } from '../errors'
import type { NodeReport, ReportAnswer } from './api'
import { REPORT_TOOL } from './prompts'
import { SOP_GUIDE } from './sop'

export { REPORT_TOOL }
export const CREATE_SOP_TOOL = 'create_sop'
export const OUTCOME_CHARS = 64
export const REPORT_CALLS_PER_MINUTE = 20
export const CREATE_SOP_CALLS_PER_MINUTE = 10
const MINUTE_MS = 60_000

const REPORT_GUIDANCE =
  'Only in a session Kettu opened for a node of a task: when the work of the node is finished, ' +
  "call it once with the id of one of the node's outcomes, a note that says what you did or " +
  'the reason for the outcome, and the document when the node hands one in. Kettu then moves ' +
  "the task along that outcome's arrow; nothing else moves it. If the call is refused, fix " +
  'what it names and call it again.'

const CREATE_SOP_GUIDANCE =
  'Use it when the user asks for a new SOP, a flow their tasks must follow. The SOP is saved ' +
  "to the user's library and waits for their approval in Kettu's Settings; no task can use it " +
  'before that.'

export const TASK_INSTRUCTIONS =
  `Use ${REPORT_TOOL} to report the outcome of a task's node. ${REPORT_GUIDANCE} ` +
  `Use ${CREATE_SOP_TOOL} to save an SOP you wrote. ${CREATE_SOP_GUIDANCE}`

export const TASK_TOOLS: Tool[] = [
  {
    name: REPORT_TOOL,
    title: 'Report SOP node',
    description: `Reports the outcome of the task node this session works on. ${REPORT_GUIDANCE}`,
    inputSchema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          minLength: 1,
          maxLength: OUTCOME_CHARS,
          description: "The id of one of the node's outcomes, as its prompt lists them.",
        },
        note: {
          type: 'string',
          minLength: 1,
          maxLength: NOTE_CHARS,
          description: 'What you did, or the reason for the outcome, in a few sentences.',
        },
        document: {
          type: 'string',
          maxLength: DOCUMENT_CHARS,
          description: 'The Markdown document, when the node hands one in.',
        },
      },
      required: ['outcome', 'note'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    // Claude Code defers MCP tools behind a search; this one must be listed from the start.
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: CREATE_SOP_TOOL,
    title: 'Create SOP',
    description: `Saves an SOP to the user's library in Kettu. ${CREATE_SOP_GUIDANCE}\n\n${SOP_GUIDE}`,
    inputSchema: {
      type: 'object',
      properties: {
        yaml: {
          type: 'string',
          minLength: 1,
          maxLength: SOP_FILE_CHARS,
          description: 'The whole SOP file, as YAML.',
        },
      },
      required: ['yaml'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

export function isTaskToolName(name: string): boolean {
  return name === REPORT_TOOL || name === CREATE_SOP_TOOL
}

export interface TaskToolsDeps {
  /** The node a session works on while it has not reported; null for any other session. */
  nodeOf(sessionId: string): { taskId: string; runId: string; nodeId: string } | null
  report(sessionId: string, report: NodeReport): Promise<ReportAnswer>
  /** Saves an SOP as made by an agent; rejects with `invalid_params` for one that does not read. */
  createSop(yaml: string): Promise<{ id: string; name: string }>
  now?(): number
}

/** A refusal before the engine or the library sees the call, which the agent reads as an error. */
export class TaskToolError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_allowed' | 'rate_limited',
    message: string,
  ) {
    super(message)
    this.name = 'TaskToolError'
  }
}

function invalid(message: string): TaskToolError {
  return new TaskToolError('invalid', message)
}

/** The call's arguments as an object of the named keys only. */
function args(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('The arguments must be an object.')
  }
  const extra = Object.keys(input).find((key) => !allowed.includes(key))
  if (extra !== undefined) throw invalid(`Unknown argument ${extra.slice(0, OUTCOME_CHARS)}.`)
  return input as Record<string, unknown>
}

/** The call's arguments as the schema says, or a refusal that names what is wrong. */
export function parseReport(input: unknown): NodeReport {
  const { outcome, note, document } = args(input, ['outcome', 'note', 'document'])
  if (typeof outcome !== 'string' || outcome === '' || outcome.length > OUTCOME_CHARS) {
    throw invalid(`outcome must be the id of one of the node's outcomes.`)
  }
  if (typeof note !== 'string' || note.trim() === '' || note.length > NOTE_CHARS) {
    throw invalid(`note must be 1 to ${NOTE_CHARS} characters.`)
  }
  if (
    document !== undefined &&
    (typeof document !== 'string' || document.length > DOCUMENT_CHARS)
  ) {
    throw invalid(`document must be text of at most ${DOCUMENT_CHARS} characters.`)
  }
  // A blank document is none, so the engine never takes one for a hand-in.
  return {
    outcome,
    note,
    ...(document === undefined || document.trim() === '' ? {} : { document }),
  }
}

/** The SOP file of a `create_sop` call, or a refusal. */
export function parseSopFile(input: unknown): string {
  const { yaml } = args(input, ['yaml'])
  if (typeof yaml !== 'string' || yaml.trim() === '' || yaml.length > SOP_FILE_CHARS) {
    throw invalid(`yaml must be the SOP file, at most ${SOP_FILE_CHARS} characters.`)
  }
  return yaml
}

function failure(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message },
    isError: true,
  }
}

export class TaskTools {
  private readonly now: () => number
  /** Each session's recent calls of each tool. */
  private readonly calls = new Map<string, Map<string, number[]>>()

  constructor(private readonly deps: TaskToolsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Serves a call; a refusal, the engine's included, becomes a tool error the agent can act on. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    try {
      if (name === REPORT_TOOL) return await this.report(caller, input)
      if (name === CREATE_SOP_TOOL) return await this.createSop(caller, input)
    } catch (error) {
      if (error instanceof TaskToolError) return failure(error.code, error.message)
      throw error
    }
    throw new Error(`Unknown tool ${name}`)
  }

  private async report(caller: Caller, input: unknown): Promise<CallToolResult> {
    if (caller.subagent) {
      throw new TaskToolError(
        'not_allowed',
        "Only the node's own agent reports; a subagent tells that agent instead.",
      )
    }
    if (!this.deps.nodeOf(caller.sessionId)) {
      throw new TaskToolError(
        'not_allowed',
        'This session is not working on a node of a task, so there is nothing to report.',
      )
    }
    const report = parseReport(input)
    this.allow(caller.sessionId, REPORT_TOOL, REPORT_CALLS_PER_MINUTE)
    const answer = await this.deps.report(caller.sessionId, report)
    if (!answer.ok) return failure('refused', answer.error)
    return {
      content: [{ type: 'text', text: answer.next }],
      structuredContent: { next: answer.next },
    }
  }

  private async createSop(caller: Caller, input: unknown): Promise<CallToolResult> {
    const yaml = parseSopFile(input)
    this.allow(caller.sessionId, CREATE_SOP_TOOL, CREATE_SOP_CALLS_PER_MINUTE)
    let saved: { id: string; name: string }
    try {
      saved = await this.deps.createSop(yaml)
    } catch (error) {
      if (error instanceof HostError && error.code === 'invalid_params') {
        return failure('invalid', error.message)
      }
      throw error
    }
    const text =
      `Saved the SOP "${saved.name}" with the id ${saved.id}. It waits for the person's ` +
      "approval in Kettu's Settings; no task can use it before that."
    return {
      content: [{ type: 'text', text }],
      structuredContent: { id: saved.id, name: saved.name, status: 'pending' },
    }
  }

  private allow(sessionId: string, tool: string, limit: number): void {
    const now = this.now()
    let tools = this.calls.get(sessionId)
    if (!tools) this.calls.set(sessionId, (tools = new Map()))
    const recent = (tools.get(tool) ?? []).filter((at) => at > now - MINUTE_MS)
    tools.set(tool, recent)
    if (recent.length >= limit) {
      const wait = Math.max(1, Math.ceil((recent[0]! + MINUTE_MS - now) / 1000))
      throw new TaskToolError('rate_limited', `Too many calls in a minute. Wait ${wait} s.`)
    }
    recent.push(now)
  }

  forget(sessionId: string): void {
    this.calls.delete(sessionId)
  }
}
