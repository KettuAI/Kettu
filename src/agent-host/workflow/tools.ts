// The workflow tools of Kettu's MCP server. An ordinary session's agent lists workflows, suggests one for
// the user to start and writes new ones for the user to approve; a step's agent reports its step
// and picks who does the next ones. Kettu checks every call; the agents never move a task.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  PACES,
  PICK_REASON_CHARS,
  REPORT_NOTE_CHARS,
  WORKFLOW_FILE_BYTES,
  TASK_TEXT_CHARS,
  TASK_TITLE_CHARS,
  isPace,
  usableWorkflow,
  type WorkflowEntry,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import { HostError } from '../errors'
import type { PickResult, ReportInput, ReportResult } from './engine'
import type { WorkflowLibrary } from './library'
import type { PickInput } from './picks'
import { PICK_TOOL, REPORT_TOOL } from './prompts'

export const LIST_WORKFLOWS_TOOL = 'list_workflows'
export const SUGGEST_WORKFLOW_TOOL = 'suggest_workflow'
export const CREATE_WORKFLOW_TOOL = 'create_workflow'
export { PICK_TOOL, REPORT_TOOL }

/** The tools a step's session gets, and only it. */
export const STEP_TOOL_NAMES: readonly string[] = [REPORT_TOOL, PICK_TOOL]
/** The tools an ordinary session gets while agents may suggest workflows. */
export const SUGGEST_TOOL_NAMES: readonly string[] = [LIST_WORKFLOWS_TOOL, SUGGEST_WORKFLOW_TOOL]
export const WORKFLOW_TOOL_NAMES: readonly string[] = [
  ...SUGGEST_TOOL_NAMES,
  CREATE_WORKFLOW_TOOL,
  ...STEP_TOOL_NAMES,
]

const MAX_PICKS = 10
const OUTCOME_CHARS = 60
const ID_CHARS = 64

const CHECKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      check: { type: 'string' },
      ok: { type: 'boolean' },
      detail: { type: ['string', 'null'] },
    },
    required: ['check', 'ok', 'detail'],
  },
}

export const WORKFLOW_TOOLS: Tool[] = [
  {
    name: LIST_WORKFLOWS_TOOL,
    title: 'List workflows',
    description:
      'Lists the workflows the user can start a task with: their ids, names, what they are for and ' +
      'their steps. Use it before suggesting one with suggest_workflow.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: SUGGEST_WORKFLOW_TOOL,
    title: 'Suggest a workflow',
    description:
      'Suggests running the requirement as a task through a workflow. Kettu shows the user a card ' +
      'with the workflow, the task text, the pace and who does each step; nothing starts until the ' +
      'user presses Start. Suggest only for work that is large enough to need its steps, and ' +
      'do not do the work yourself while the card waits.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          maxLength: ID_CHARS,
          description: 'An id list_workflows gave.',
        },
        task: {
          type: 'string',
          minLength: 1,
          maxLength: TASK_TEXT_CHARS,
          description: 'The requirement, written so that every step can work from it alone.',
        },
        title: { type: 'string', maxLength: TASK_TITLE_CHARS, description: 'A short name.' },
        pace: {
          type: 'string',
          enum: [...PACES],
          description:
            'quick to try an idea fast, thorough for work that must hold, balanced otherwise.',
        },
        pace_reason: {
          type: 'string',
          maxLength: PICK_REASON_CHARS,
          description: 'One line on why that pace.',
        },
      },
      required: ['workflow_id', 'task', 'pace'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    // Claude Code defers MCP tools behind a search; an entry tool must be listed from the start.
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: CREATE_WORKFLOW_TOOL,
    title: 'Write a workflow',
    description:
      "Saves a workflow you wrote as YAML into the user's library, where it waits for the user to " +
      'approve it before any task can use it. A file with problems is refused with each problem ' +
      'and where it is; fix them and call again. Format: `format: 1`, `name`, `description`, ' +
      'optional `send_back_limit`, and `steps` in order, the first being the start. A step has ' +
      '`id` (kebab-case), `name`, `prompt`, `by` (agent or you), `hand_in` (document, outcome or ' +
      'note), `outcomes` (each a `name` with `to` naming one step, several steps to run at ' +
      'once, or `end: done` / `end: dropped`), and optionally `you_review`, `hint`, `review_of` ' +
      'and `tools` (`mcp` and `skills` by name). Never name an agent, harness or model.',
    inputSchema: {
      type: 'object',
      properties: {
        yaml: { type: 'string', minLength: 1, maxLength: WORKFLOW_FILE_BYTES },
      },
      required: ['yaml'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: REPORT_TOOL,
    title: 'Report the step',
    description:
      'Reports that your workflow step is done, with one of its outcomes and what it hands in. Kettu ' +
      'checks the report and refuses it with what to fix; when it is accepted, Kettu moves the ' +
      'task. When the result asks you to pick who does the next steps, call pick_step_agents.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          maxLength: OUTCOME_CHARS,
          description: "One of the step's outcomes, as your first message lists them.",
        },
        note: { type: 'string', maxLength: REPORT_NOTE_CHARS },
        artifact_id: {
          type: 'string',
          maxLength: ID_CHARS,
          description: 'The document artifact the step hands in, when it hands in a document.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean' },
        checks: CHECKS_SCHEMA,
        next: { type: 'object' },
        facts: { type: ['object', 'null'] },
      },
      required: ['accepted', 'checks', 'next', 'facts'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: PICK_TOOL,
    title: 'Pick who does the next steps',
    description:
      'Picks the agent, model and effort for each step your report listed, from the facts it ' +
      'gave: what each step needs, the pace, the agents you may pick with their models, ' +
      "efforts and plan limits, Kettu's notes on the models and who did the step before. Give a " +
      'one-line reason for each. Kettu checks that each pick can run, never whether it is a good ' +
      'one; a refused pick says why.',
    inputSchema: {
      type: 'object',
      properties: {
        picks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PICKS,
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', maxLength: ID_CHARS },
              agent: { type: 'string', maxLength: ID_CHARS, description: 'An agent id.' },
              model: { type: ['string', 'null'], maxLength: 200 },
              effort: { type: ['string', 'null'], maxLength: 64 },
              reason: { type: 'string', minLength: 1, maxLength: PICK_REASON_CHARS },
            },
            required: ['step', 'agent', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['picks'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean' },
        checks: { type: 'array' },
        next: { type: 'object' },
      },
      required: ['accepted', 'checks', 'next'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { 'anthropic/alwaysLoad': true },
  },
]

export function isWorkflowToolName(name: string): boolean {
  return WORKFLOW_TOOL_NAMES.includes(name)
}

/**
 * The structured content of a workflow tool's call as a harness passed it on, Claude Code as JSON
 * text, for the call's card; the facts a report gives to pick from stay in the call's text.
 */
export function workflowToolStructured(
  tool: string,
  structured: unknown,
): Record<string, unknown> | undefined {
  if (!isWorkflowToolName(tool)) return undefined
  let value = structured
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const kept = { ...(value as Record<string, unknown>) }
  delete kept.facts
  return kept
}

export interface WorkflowToolsDeps {
  library: Pick<WorkflowLibrary, 'list' | 'create' | 'suggest'>
  report(sessionId: string, input: ReportInput): Promise<ReportResult>
  pick(sessionId: string, picks: PickInput[]): Promise<PickResult>
  /** The session works for a workflow step. */
  isStep(sessionId: string): boolean
  /** The agent of a session Kettu has. */
  agentOf(sessionId: string): AgentId | null
}

type ErrorCode = 'invalid' | 'not_allowed' | 'not_found'

class WorkflowToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowToolError'
  }
}

function failure(error: WorkflowToolError): CallToolResult {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { code: error.code, message: error.message },
    isError: true,
  }
}

function objectOf(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WorkflowToolError('invalid', 'The arguments must be an object.')
  }
  const extra = Object.keys(input).find((key) => !allowed.includes(key))
  if (extra !== undefined) throw new WorkflowToolError('invalid', `Unknown argument ${extra}.`)
  return input as Record<string, unknown>
}

function text(o: Record<string, unknown>, key: string, max: number, required: boolean) {
  const value = o[key]
  if (value === undefined || value === null) {
    if (required) throw new WorkflowToolError('invalid', `${key} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new WorkflowToolError('invalid', `${key} must be a string.`)
  if (value.length > max) throw new WorkflowToolError('invalid', `${key} is longer than ${max}.`)
  if (required && value.trim() === '') throw new WorkflowToolError('invalid', `${key} is empty.`)
  return value
}

function result(text: string, structured: Record<string, unknown>, error = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(error ? { isError: true } : {}),
  }
}

function workflowListing(entry: WorkflowEntry) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.workflow?.description ?? '',
    steps: (entry.workflow?.steps ?? []).map((step) => ({
      id: step.id,
      name: step.name,
      by: step.by,
      you_review: step.youReview,
    })),
  }
}

function checksText(lines: { check: string; ok: boolean; detail: string | null }[]): string {
  return lines
    .filter((line) => !line.ok)
    .map((line) => `- ${line.detail ?? line.check}`)
    .join('\n')
}

export class WorkflowTools {
  constructor(private readonly deps: WorkflowToolsDeps) {}

  /** Whether the user lets agents suggest workflows, which lists the tools for it. */
  get suggests(): boolean {
    return this.deps.library.suggest
  }

  /** The tools the session sees: a step's own two, or the others. */
  listed(sessionId: string | null): Tool[] {
    if (sessionId !== null && this.deps.isStep(sessionId)) {
      return WORKFLOW_TOOLS.filter((tool) => STEP_TOOL_NAMES.includes(tool.name))
    }
    return WORKFLOW_TOOLS.filter(
      (tool) =>
        tool.name === CREATE_WORKFLOW_TOOL ||
        (this.suggests && SUGGEST_TOOL_NAMES.includes(tool.name)),
    )
  }

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    try {
      if (caller.subagent) {
        throw new WorkflowToolError(
          'not_allowed',
          'Only the main agent of a session uses the workflow tools.',
        )
      }
      const step = this.deps.isStep(caller.sessionId)
      if (STEP_TOOL_NAMES.includes(name)) {
        if (!step) {
          throw new WorkflowToolError(
            'not_allowed',
            `${name} is only for the session of a workflow step.`,
          )
        }
        return name === REPORT_TOOL
          ? await this.report(caller.sessionId, input)
          : await this.pick(caller.sessionId, input)
      }
      if (step) {
        throw new WorkflowToolError(
          'not_allowed',
          `A step's session reports with ${REPORT_TOOL} only.`,
        )
      }
      switch (name) {
        case LIST_WORKFLOWS_TOOL:
          return await this.list(input)
        case SUGGEST_WORKFLOW_TOOL:
          return await this.suggest(input)
        case CREATE_WORKFLOW_TOOL:
          return await this.create(caller.sessionId, input)
        default:
          throw new Error(`Unknown tool ${name}`)
      }
    } catch (error) {
      if (error instanceof WorkflowToolError) return failure(error)
      if (error instanceof HostError)
        return failure(new WorkflowToolError('invalid', error.message))
      throw error
    }
  }

  private async usable(): Promise<WorkflowEntry[]> {
    if (!this.deps.library.suggest) {
      throw new WorkflowToolError('not_allowed', 'The user turned off workflow suggestions.')
    }
    return (await this.deps.library.list()).filter(usableWorkflow)
  }

  private async list(input: unknown): Promise<CallToolResult> {
    objectOf(input ?? {}, [])
    const workflows = (await this.usable()).map(workflowListing)
    const lines = workflows.map(
      (workflow) => `- ${workflow.id}: ${workflow.name}. ${workflow.description}`,
    )
    return result(lines.length > 0 ? lines.join('\n') : 'No workflow can be started now.', {
      workflows,
    })
  }

  private async suggest(input: unknown): Promise<CallToolResult> {
    const o = objectOf(input, ['workflow_id', 'task', 'title', 'pace', 'pace_reason'])
    const workflowId = text(o, 'workflow_id', ID_CHARS, true)!
    const task = text(o, 'task', TASK_TEXT_CHARS, true)!
    const title = text(o, 'title', TASK_TITLE_CHARS, false)
    const paceReason = text(o, 'pace_reason', PICK_REASON_CHARS, false)
    if (!isPace(o.pace))
      throw new WorkflowToolError('invalid', 'pace must be quick, balanced or thorough.')
    const entry = (await this.usable()).find((workflow) => workflow.id === workflowId)
    if (!entry) {
      throw new WorkflowToolError(
        'not_found',
        `No workflow ${workflowId} can be started; use an id list_workflows gave.`,
      )
    }
    const suggestion = {
      workflow_id: entry.id,
      workflow_name: entry.name,
      task,
      title,
      pace: o.pace,
      pace_reason: paceReason,
    }
    return result(
      `The user sees your suggestion to run this through "${entry.name}" and decides. ` +
        'Wait for them: do not start the work yourself.',
      { suggestion },
    )
  }

  private async create(sessionId: string, input: unknown): Promise<CallToolResult> {
    const o = objectOf(input, ['yaml'])
    const yaml = text(o, 'yaml', WORKFLOW_FILE_BYTES, true)!
    const agentId = this.deps.agentOf(sessionId)
    if (!agentId) throw new WorkflowToolError('not_found', 'Kettu does not have this session.')
    const saved = await this.deps.library.create(yaml, { sessionId, agentId })
    // A workflow entry lists its problems too; a refusal is the one without an id.
    if (!('id' in saved)) {
      const lines = saved.problems.map((p) => `- ${p.at ? `${p.at}: ` : ''}${p.message}`)
      return result(
        `The workflow was not saved. Fix these and call ${CREATE_WORKFLOW_TOOL} again:\n${lines.join('\n')}`,
        { saved: false, problems: saved.problems },
        true,
      )
    }
    return result(
      `Saved "${saved.name}" as ${saved.id}. It waits for the user to approve it in the ` +
        'Marketplace before any task can use it.',
      {
        saved: true,
        workflow_id: saved.id,
        name: saved.name,
        hash: saved.hash,
        approval: saved.approval,
      },
    )
  }

  private async report(sessionId: string, input: unknown): Promise<CallToolResult> {
    const o = objectOf(input ?? {}, ['outcome', 'note', 'artifact_id'])
    const report: ReportInput = {
      outcome: text(o, 'outcome', OUTCOME_CHARS, false),
      note: text(o, 'note', REPORT_NOTE_CHARS, false),
      artifactId: text(o, 'artifact_id', ID_CHARS, false),
    }
    const answer = await this.deps.report(sessionId, report)
    const structured = { ...answer } as unknown as Record<string, unknown>
    if (!answer.accepted) {
      return result(`Kettu refused the report:\n${checksText(answer.checks)}`, structured, true)
    }
    let message: string
    switch (answer.next.kind) {
      case 'pick':
        message =
          `Report accepted. Now pick who does ${answer.next.steps.join(', ')} with ${PICK_TOOL}, ` +
          `from these facts:\n${JSON.stringify(answer.facts)}`
        break
      case 'review':
        message = 'Report accepted. The user reviews what you handed in; your step is done for now.'
        break
      case 'end':
        message = `Report accepted. The task ends as ${answer.next.end}; you are done.`
        break
      case 'stuck':
        message =
          'Report accepted, but this arrow back was taken as often as it may be; the task waits for the user. You are done for now.'
        break
      default:
        message = 'Report accepted. Kettu moves the task on; you are done.'
    }
    return result(message, structured)
  }

  private async pick(sessionId: string, input: unknown): Promise<CallToolResult> {
    const o = objectOf(input, ['picks'])
    if (!Array.isArray(o.picks) || o.picks.length === 0 || o.picks.length > MAX_PICKS) {
      throw new WorkflowToolError('invalid', `picks must list 1 to ${MAX_PICKS} picks.`)
    }
    const picks: PickInput[] = o.picks.map((item, i) => {
      const p = objectOf(item, ['step', 'agent', 'model', 'effort', 'reason'])
      const where = `Pick ${i + 1}`
      const step = text(p, 'step', ID_CHARS, true)
      const agent = text(p, 'agent', ID_CHARS, true)
      const reason = text(p, 'reason', PICK_REASON_CHARS, true)
      if (!step || !agent || !reason)
        throw new WorkflowToolError('invalid', `${where} is incomplete.`)
      return {
        step,
        agent,
        model: text(p, 'model', 200, false),
        effort: text(p, 'effort', 64, false),
        reason,
      }
    })
    const answer = await this.deps.pick(sessionId, picks)
    const structured = { ...answer } as unknown as Record<string, unknown>
    const refused = answer.checks
      .map((c) => {
        const lines = checksText(c.lines)
        return lines ? `${c.step}:\n${lines}` : ''
      })
      .filter(Boolean)
      .join('\n')
    if (answer.next.kind === 'stuck') {
      return result(
        `Kettu refused the picks too often; the task waits for the user.\n${refused}`,
        structured,
        true,
      )
    }
    if (refused) {
      return result(`Some picks do not hold; pick again for them:\n${refused}`, structured, true)
    }
    if (answer.next.kind === 'pick') {
      return result(`Picked. Still to pick: ${answer.next.steps.join(', ')}.`, structured)
    }
    return result('Picked. Kettu moves the task on; you are done.', structured)
  }
}
