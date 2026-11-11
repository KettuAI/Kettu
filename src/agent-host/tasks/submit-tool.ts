// The submit tool of Kettu's MCP service: how the agent of a task's stage hands in its result.
// The tool only checks the call's shape and who makes it; the task engine checks the result
// against the stage and moves the task on.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Caller } from '../artifacts/tools'
import { SERVICE_NAME } from '../service-name'
import type { StageSubmission, SubmitAnswer } from './api'

export const SUBMIT_TOOL = 'submit_stage'
export const SUMMARY_CHARS = 4_000
export const MAX_FIELDS = 40
export const FIELD_NAME_CHARS = 64
export const FIELD_TEXT_CHARS = 20_000
export const MAX_LIST_ITEMS = 200
export const LIST_ITEM_CHARS = 2_000
export const SUBMIT_CALLS_PER_MINUTE = 20
const MINUTE_MS = 60_000

const VERDICTS: readonly StageSubmission['verdict'][] = ['pass', 'changes', 'blocked']
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

const SUBMIT_GUIDANCE =
  'Only in a session Kettu opened for a stage of a task: when the stage is finished, call it ' +
  "once with your verdict, a short summary and every field the stage's prompt asks for. " +
  'Report only what you did in this session; Kettu checks commands and changed files against ' +
  'your own tool calls. If the call is refused, fix what it names and call it again.'

export const SUBMIT_INSTRUCTIONS = `Use ${SUBMIT_TOOL} to hand in a task stage's result. ${SUBMIT_GUIDANCE}`

export const SUBMIT_PROMPT =
  `In a task stage, hand in the result with the \`${SUBMIT_TOOL}\` tool of the ` +
  `\`${SERVICE_NAME}\` MCP server. ${SUBMIT_GUIDANCE}`

export const SUBMIT_TOOLS: Tool[] = [
  {
    name: SUBMIT_TOOL,
    title: 'Submit stage',
    description: `Hands in the result of the current task stage. ${SUBMIT_GUIDANCE}`,
    inputSchema: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: [...VERDICTS],
          description:
            'pass: the stage is done; changes: what you checked needs changes; blocked: you cannot go on without the person.',
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: SUMMARY_CHARS,
          description: 'What you did and found, in a few sentences.',
        },
        fields: {
          type: 'object',
          description:
            "The fields the stage's prompt names: text, a list of texts, or true or false.",
          maxProperties: MAX_FIELDS,
          additionalProperties: {
            anyOf: [
              { type: 'string', maxLength: FIELD_TEXT_CHARS },
              {
                type: 'array',
                maxItems: MAX_LIST_ITEMS,
                items: { type: 'string', maxLength: LIST_ITEM_CHARS },
              },
              { type: 'boolean' },
            ],
          },
        },
        escalate: {
          type: 'boolean',
          description: 'Ask for a stronger model for the next round of this stage.',
        },
      },
      required: ['verdict', 'summary', 'fields'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    // Claude Code defers MCP tools behind a search; this one must be listed from the start.
    _meta: { 'anthropic/alwaysLoad': true },
  },
]

export function isSubmitToolName(name: string): boolean {
  return name === SUBMIT_TOOL
}

export interface SubmitToolsDeps {
  /** The stage a session works for while it is current; null for any other session. */
  stageOf(sessionId: string): { taskId: string; runId: string; stageId: string } | null
  submit(sessionId: string, submission: StageSubmission): Promise<SubmitAnswer>
  now?(): number
}

/** A refusal before the engine sees the call, which the agent reads as the tool's error. */
export class SubmitToolError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_allowed' | 'rate_limited',
    message: string,
  ) {
    super(message)
    this.name = 'SubmitToolError'
  }
}

function invalid(message: string): SubmitToolError {
  return new SubmitToolError('invalid', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The call's arguments as the schema says, or a refusal that names what is wrong. */
export function parseSubmission(input: unknown): StageSubmission {
  if (!isObject(input)) throw invalid('The arguments must be an object.')
  const extra = Object.keys(input).find(
    (key) => key !== 'verdict' && key !== 'summary' && key !== 'fields' && key !== 'escalate',
  )
  if (extra !== undefined) throw invalid(`Unknown argument ${extra}.`)
  const { verdict, summary, fields, escalate } = input
  if (!VERDICTS.includes(verdict as StageSubmission['verdict'])) {
    throw invalid('verdict must be pass, changes or blocked.')
  }
  if (typeof summary !== 'string' || summary.trim() === '' || summary.length > SUMMARY_CHARS) {
    throw invalid(`summary must be 1 to ${SUMMARY_CHARS} characters.`)
  }
  if (!isObject(fields)) throw invalid('fields must be an object of the fields the stage names.')
  const entries = Object.entries(fields)
  if (entries.length > MAX_FIELDS) throw invalid(`fields holds more than ${MAX_FIELDS} fields.`)
  const parsed: StageSubmission['fields'] = {}
  for (const [name, value] of entries) {
    if (name.length > FIELD_NAME_CHARS || !FIELD_NAME.test(name)) {
      throw invalid(`The field name ${name.slice(0, FIELD_NAME_CHARS)} is not allowed.`)
    }
    parsed[name] = fieldValue(name, value)
  }
  if (escalate !== undefined && typeof escalate !== 'boolean') {
    throw invalid('escalate must be true or false.')
  }
  return {
    verdict: verdict as StageSubmission['verdict'],
    summary,
    fields: parsed,
    ...(escalate === undefined ? {} : { escalate }),
  }
}

function fieldValue(name: string, value: unknown): string | string[] | boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.length > FIELD_TEXT_CHARS) {
      throw invalid(`fields.${name} is longer than ${FIELD_TEXT_CHARS} characters.`)
    }
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) {
      throw invalid(`fields.${name} holds more than ${MAX_LIST_ITEMS} items.`)
    }
    return value.map((item, index) => {
      if (typeof item !== 'string' || item.length > LIST_ITEM_CHARS) {
        throw invalid(`fields.${name}[${index}] must be text of at most ${LIST_ITEM_CHARS}.`)
      }
      return item
    })
  }
  throw invalid(`fields.${name} must be text, a list of texts, or true or false.`)
}

function failure(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message },
    isError: true,
  }
}

export class SubmitTools {
  private readonly now: () => number
  private readonly calls = new Map<string, number[]>()

  constructor(private readonly deps: SubmitToolsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Serves a call; a refusal, the engine's included, becomes a tool error the agent can act on. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    if (name !== SUBMIT_TOOL) throw new Error(`Unknown tool ${name}`)
    try {
      if (caller.subagent) {
        throw new SubmitToolError(
          'not_allowed',
          "Only the stage's own agent submits; a subagent reports to it instead.",
        )
      }
      if (!this.deps.stageOf(caller.sessionId)) {
        throw new SubmitToolError(
          'not_allowed',
          'This session is not working on a task stage, so there is nothing to submit.',
        )
      }
      const submission = parseSubmission(input)
      this.allow(caller.sessionId)
      const answer = await this.deps.submit(caller.sessionId, submission)
      if (!answer.ok) return failure('refused', answer.error)
      return {
        content: [{ type: 'text', text: answer.next }],
        structuredContent: { next: answer.next },
      }
    } catch (error) {
      if (error instanceof SubmitToolError) return failure(error.code, error.message)
      throw error
    }
  }

  private allow(sessionId: string): void {
    const now = this.now()
    const recent = (this.calls.get(sessionId) ?? []).filter((at) => at > now - MINUTE_MS)
    if (recent.length >= SUBMIT_CALLS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((recent[0]! + MINUTE_MS - now) / 1000))
      this.calls.set(sessionId, recent)
      throw new SubmitToolError('rate_limited', `Too many submissions in a minute. Wait ${wait} s.`)
    }
    recent.push(now)
    this.calls.set(sessionId, recent)
  }

  forget(sessionId: string): void {
    this.calls.delete(sessionId)
  }
}
