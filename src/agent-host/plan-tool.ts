// The plan tool of the artifacts service: what agents are told, the schema, the checks and the
// limits. The host writes the plan into the calling session's thread; no agent mapper reads the
// call, so every agent that takes the service shows its plan the same way.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { longer } from '@shared/artifacts'
import type { PlanItem } from '@shared/thread'
import type { Caller } from './artifacts/tools'
import { SERVICE_NAME } from './service-name'

export const PLAN_TOOL = 'set_plan'
export const MAX_STEPS = 20
export const STEP_CHARS = 60
export const PLAN_CALLS_PER_MINUTE = 60
const MINUTE_MS = 60_000

const STATUSES: readonly PlanItem['status'][] = ['pending', 'in_progress', 'completed']

/** Shared by the service, tool and agent instructions so the plan rules stay in step. */
const PLAN_GUIDANCE =
  'For a task of two or more steps, set a plan before starting and update the whole list after ' +
  "each completed step or plan change. Prefer 3-5 steps in the user's language. Each step is a " +
  'short action label: about 4-12 Chinese characters or 3-6 English words, not a sentence. ' +
  'Keep details, file paths and explanations in your reply. Keep at most one step in_progress ' +
  'and mark only finished work completed. Before your final reply, update the plan to match ' +
  'the outcome: all steps completed if the task is done; unfinished steps pending if blocked ' +
  'or waiting for the user, with the reason in your reply. Do not claim completion while the ' +
  'plan is stale. Skip plans for one-step tasks. Use this tool or a built-in plan tool, never ' +
  'both. Subagents must not call this tool.'

export const PLAN_INSTRUCTIONS = `Use ${PLAN_TOOL} to show task progress. ${PLAN_GUIDANCE}`

export const PLAN_PROMPT =
  `Use the \`${PLAN_TOOL}\` tool of the \`${SERVICE_NAME}\` MCP server to show task progress. ` +
  PLAN_GUIDANCE

export const PLAN_TOOLS: Tool[] = [
  {
    name: PLAN_TOOL,
    title: 'Set plan',
    description: `Shows a brief progress plan in the session's top bar. ${PLAN_GUIDANCE}`,
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          description: 'Every step of the plan, in order, replacing the previous list.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                minLength: 1,
                maxLength: STEP_CHARS,
                description:
                  'A short action label: about 4-12 Chinese characters or 3-6 English words. No explanations.',
              },
              status: { type: 'string', enum: [...STATUSES] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        done: { type: 'integer' },
        total: { type: 'integer' },
        next: { type: ['string', 'null'] },
      },
      required: ['done', 'total', 'next'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    // Claude Code defers MCP tools behind a search; this one must be listed from the start.
    _meta: { 'anthropic/alwaysLoad': true },
  },
]

export function isPlanToolName(name: string): boolean {
  return name === PLAN_TOOL
}

/** Claude Code's name for the tool in its calls, which show no row: the plan is their display. */
export function isClaudePlanCall(name: string): boolean {
  return name === `mcp__${SERVICE_NAME}__${PLAN_TOOL}`
}

/** An MCP tool call of Codex, named by its server and tool. */
export function isCodexPlanCall(server: string, tool: string): boolean {
  return server === SERVICE_NAME && tool === PLAN_TOOL
}

export interface PlanToolsDeps {
  /** Writes the plan into the session's thread; false for a session Kettu holds no thread for. */
  set(sessionId: string, items: PlanItem[]): boolean
  now?(): number
}

type PlanToolErrorCode = 'invalid' | 'not_allowed' | 'not_found' | 'rate_limited'

/** A refusal, returned as a tool error whose text says what to do next. */
export class PlanToolError extends Error {
  constructor(
    readonly code: PlanToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PlanToolError'
  }
}

function invalid(message: string): PlanToolError {
  return new PlanToolError('invalid', message)
}

/** The steps a call carries, checked as the schema says; a step's text is cut to one line. */
export function parseSteps(input: unknown): PlanItem[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('The arguments must be an object with a steps list.')
  }
  const keys = Object.keys(input)
  const unknown = keys.find((key) => key !== 'steps')
  if (unknown !== undefined) throw invalid(`Unknown argument ${unknown}.`)
  const steps = (input as Record<string, unknown>).steps
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
    throw invalid(`steps must be a list of 1 to ${MAX_STEPS} steps.`)
  }
  return steps.map((step, i) => {
    const where = `Step ${i + 1}`
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw invalid(`${where} must be an object with content and status.`)
    }
    const fields = step as Record<string, unknown>
    const extra = Object.keys(fields).find((key) => key !== 'content' && key !== 'status')
    if (extra !== undefined) throw invalid(`${where} has an unknown field ${extra}.`)
    const content =
      typeof fields.content === 'string' ? fields.content.replace(/\s+/g, ' ').trim() : ''
    if (content === '' || longer(content, STEP_CHARS)) {
      throw invalid(
        `${where}: content must be 1 to ${STEP_CHARS} characters. Use a short action label.`,
      )
    }
    const status = fields.status
    if (!STATUSES.includes(status as PlanItem['status'])) {
      throw invalid(`${where}: status must be pending, in_progress or completed.`)
    }
    return { content, priority: 'medium', status: status as PlanItem['status'] }
  })
}

function failure(error: PlanToolError): CallToolResult {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { code: error.code, message: error.message },
    isError: true,
  }
}

export class PlanTools {
  private readonly now: () => number
  /** When each session's latest calls were made, for the rate limit. */
  private readonly calls = new Map<string, number[]>()

  constructor(private readonly deps: PlanToolsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Serves a call; a refusal becomes a tool error. */
  call(caller: Caller, name: string, input: unknown): CallToolResult {
    if (name !== PLAN_TOOL) throw new Error(`Unknown tool ${name}`)
    try {
      return this.set(caller, input)
    } catch (error) {
      if (error instanceof PlanToolError) return failure(error)
      throw error
    }
  }

  private set(caller: Caller, input: unknown): CallToolResult {
    if (caller.subagent) {
      throw new PlanToolError('not_allowed', 'Only the main agent sets the plan.')
    }
    const items = parseSteps(input)
    this.allow(caller)
    if (!this.deps.set(caller.sessionId, items)) {
      throw new PlanToolError('not_found', 'This session is not open, so it shows no plan.')
    }
    const done = items.filter((item) => item.status === 'completed').length
    const next =
      (
        items.find((item) => item.status === 'in_progress') ??
        items.find((item) => item.status === 'pending')
      )?.content ?? null
    const text =
      next === null
        ? `Plan saved: all ${items.length} steps are done.`
        : `Plan saved: ${done} of ${items.length} steps done. Next: ${next}. ` +
          `Before your final reply, call ${PLAN_TOOL} with the actual final status of every step.`
    return {
      content: [{ type: 'text', text }],
      structuredContent: { done, total: items.length, next },
    }
  }

  /** Counts the call against the session's minute; a session cannot flood its thread. */
  private allow(caller: Caller): void {
    const now = this.now()
    const recent = (this.calls.get(caller.sessionId) ?? []).filter((at) => at > now - MINUTE_MS)
    if (recent.length >= PLAN_CALLS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((recent[0]! + MINUTE_MS - now) / 1000))
      this.calls.set(caller.sessionId, recent)
      throw new PlanToolError('rate_limited', `Too many plan updates in a minute. Wait ${wait} s.`)
    }
    recent.push(now)
    this.calls.set(caller.sessionId, recent)
  }

  /** The session left memory: its calls need no counting. */
  forget(sessionId: string): void {
    this.calls.delete(sessionId)
  }
}
