// The calls of the workflow tools of Kettu's MCP server, which the thread draws as cards: what they
// asked and what Kettu answered, and the card a suggestion or a workflow to keep shows.

import type { CheckLine, CheckNext, PickCheck, ReportCheck } from '@shared/workflow'
import { KETTU_SERVER, mcpCallOf } from '@shared/mcp-call'
import type { ThreadState, ToolEntry } from '@shared/thread'
import { useSuggestionsStore } from '@renderer/stores/workflow-suggestions'

/** The tools' names on Kettu's MCP server, the one place they are written here. */
const WORKFLOW_TOOLS = {
  start: 'suggest_workflow',
  create: 'create_workflow',
  report: 'report_step',
  pick: 'pick_step_agents',
} as const

export type WorkflowTool = keyof typeof WORKFLOW_TOOLS

const BY_NAME = new Map(
  Object.entries(WORKFLOW_TOOLS).map(([tool, name]) => [name, tool as WorkflowTool]),
)

export function workflowToolOf(entry: Pick<ToolEntry, 'title'>): WorkflowTool | null {
  const call = mcpCallOf(entry.title)
  // A bare tool name, as some agents title a call, is Kettu's: no other tool has these names.
  const name = call ? (call.server === KETTU_SERVER ? call.tool : null) : entry.title.trim()
  return (name && BY_NAME.get(name as (typeof WORKFLOW_TOOLS)[WorkflowTool])) || null
}

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/** The call's arguments, as the host kept them as JSON text. */
function inputOf(entry: ToolEntry): Fields {
  if (!entry.rawInput) return {}
  try {
    const parsed = JSON.parse(entry.rawInput) as unknown
    return isFields(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** What Kettu answered in words, as the agent read it. */
export function resultText(entry: ToolEntry): string {
  return entry.content
    .flatMap((item) => (item.type === 'markdown' ? [item.markdown] : []))
    .join('\n')
    .trim()
}

/** The lines of an answer that list what did not hold, as Kettu writes them. */
export function listedLines(answer: string): string[] {
  return answer
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
}

const CARD_ID = /\bwfs-[a-z2-7]{12}\b/

/** The host's card a call showed: from its structured answer, or the words that name it. */
export function cardIdOf(entry: ToolEntry): string | null {
  const given = isFields(entry.structured?.suggestion) ? entry.structured.suggestion : {}
  const id = text(given.id)
  if (id && CARD_ID.test(id)) return id
  return CARD_ID.exec(resultText(entry))?.[0] ?? null
}

export type SavedWorkflow =
  { saved: true; workflowId: string; name: string } | { saved: false; problems: string[] }

export function savedOf(entry: ToolEntry): SavedWorkflow | null {
  const result = entry.structured
  if (result?.saved === true && text(result.workflow_id) && text(result.name)) {
    return { saved: true, workflowId: result.workflow_id as string, name: result.name as string }
  }
  if (result?.saved === false && Array.isArray(result.problems)) {
    const problems = result.problems.flatMap((p: unknown) => {
      if (!isFields(p) || !text(p.message)) return []
      return [text(p.at) ? `${p.at as string}: ${p.message as string}` : (p.message as string)]
    })
    return { saved: false, problems }
  }
  if (entry.status === 'failed') return { saved: false, problems: listedLines(resultText(entry)) }
  return null
}

const isCheckLine = (value: unknown): value is CheckLine<string> =>
  isFields(value) &&
  typeof value.check === 'string' &&
  typeof value.ok === 'boolean' &&
  (value.detail === null || typeof value.detail === 'string')

const isNext = (value: unknown): value is CheckNext =>
  isFields(value) && typeof value.kind === 'string'

export interface ReportCall {
  outcome: string | null
  accepted: boolean
  /** Null where the harness passed on only Kettu's words. */
  checks: CheckLine<ReportCheck>[] | null
  next: CheckNext | null
  answer: string
}

export function reportOf(entry: ToolEntry): ReportCall {
  const input = inputOf(entry)
  const result = entry.structured
  const checks =
    Array.isArray(result?.checks) && result.checks.every(isCheckLine)
      ? (result.checks as CheckLine<ReportCheck>[])
      : null
  return {
    outcome: text(input.outcome),
    accepted: typeof result?.accepted === 'boolean' ? result.accepted : entry.status !== 'failed',
    checks,
    next: isNext(result?.next) ? result.next : null,
    answer: resultText(entry),
  }
}

export interface PickInput {
  step: string
  agent: string
  model: string | null
  effort: string | null
  reason: string | null
}

export interface PickCall {
  picks: PickInput[]
  accepted: boolean
  checks: { step: string; lines: CheckLine<PickCheck>[] }[] | null
  next: CheckNext | null
  answer: string
}

export function pickOf(entry: ToolEntry): PickCall {
  const input = inputOf(entry)
  const picks = (Array.isArray(input.picks) ? input.picks : []).flatMap((p: unknown) => {
    if (!isFields(p) || !text(p.step) || !text(p.agent)) return []
    return [
      {
        step: p.step as string,
        agent: p.agent as string,
        model: text(p.model),
        effort: text(p.effort),
        reason: text(p.reason),
      },
    ]
  })
  const result = entry.structured
  const checks = Array.isArray(result?.checks)
    ? (result.checks as unknown[]).flatMap((c) =>
        isFields(c) &&
        typeof c.step === 'string' &&
        Array.isArray(c.lines) &&
        c.lines.every(isCheckLine)
          ? [{ step: c.step, lines: c.lines as CheckLine<PickCheck>[] }]
          : [],
      )
    : null
  return {
    picks,
    accepted: typeof result?.accepted === 'boolean' ? result.accepted : entry.status !== 'failed',
    checks,
    next: isNext(result?.next) ? result.next : null,
    answer: resultText(entry),
  }
}

/**
 * The call is drawn as its workflow card once it ended: a suggestion or a workflow to keep when it
 * made one; a draft for a suggestion folds as work.
 */
export function workflowCardOf(entry: ToolEntry): WorkflowTool | null {
  const tool = workflowToolOf(entry)
  if (!tool || entry.permission) return null
  if (tool === 'start') return entry.status === 'completed' && cardIdOf(entry) ? tool : null
  if (tool === 'create' && entry.status === 'completed') {
    return cardIdOf(entry) || savedOf(entry) ? tool : null
  }
  return entry.status === 'completed' || entry.status === 'failed' ? tool : null
}

/**
 * The card that waits for the user's answer: one waiting, or stopped on a failure for Retry, that
 * no message of theirs has come after, since a message moves the conversation on.
 */
export function openSuggestion(state: ThreadState): string | null {
  const { byId } = useSuggestionsStore.getState()
  for (let i = state.order.length - 1; i >= 0; i--) {
    const entry = state.byId[state.order[i]!]
    if (entry?.kind === 'user') return null
    if (entry?.kind !== 'tool') continue
    const tool = workflowCardOf(entry)
    if (tool !== 'start' && tool !== 'create') continue
    const id = cardIdOf(entry)
    const answer = id ? byId[id]?.answer.kind : undefined
    if (answer === 'waiting' || answer === 'failed') return entry.id
  }
  return null
}
