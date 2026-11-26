// The calls of the workflow tools of Kettu's MCP server, which the thread draws as cards: what they
// asked and what Kettu answered, and the card a suggestion or a workflow to keep shows.

import type { SessionSummary } from '@shared/agent-host'
import type { CheckLine, CheckNext, PickCheck, ReportCheck } from '@shared/workflow'
import { workflowToolOfTitle, type WorkflowCardTool } from '@shared/mcp-call'
import { hasToolDigest, toolContentItems, type ThreadState, type ToolEntry } from '@shared/thread'
import { useSuggestionsStore } from '@renderer/stores/workflow-suggestions'

export type WorkflowTool = WorkflowCardTool

export function workflowToolOf(entry: Pick<ToolEntry, 'title'>): WorkflowTool | null {
  return workflowToolOfTitle(entry.title)
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

/** Whether any markdown output item of this tool call was replaced by a remote digest. */
export function hasDigestedContent(entry: Pick<ToolEntry, 'content'>): boolean {
  return toolContentItems(entry).some((item) => item.type === 'digest' && item.of === 'markdown')
}

/**
 * Whether this workflow card entry still needs `sessions.entry` to restore digested fields
 * (for example when connected to an older host that digested workflow tool output or input).
 */
export function needsFullWorkflowEntry(entry: ToolEntry): boolean {
  const tool = workflowToolOf(entry)
  if (!tool || entry.permission) return false
  if (tool === 'start') {
    return entry.status === 'completed' && cardIdOf(entry) === null && hasDigestedContent(entry)
  }
  if (tool === 'create') {
    if (entry.status === 'completed') {
      return cardIdOf(entry) === null && savedOf(entry) === null && hasDigestedContent(entry)
    }
    return entry.status === 'failed' && !entry.structured && hasDigestedContent(entry)
  }
  return (entry.status === 'completed' || entry.status === 'failed') && hasToolDigest(entry)
}

/** Fallback workflow name read from the tool entry when the host card record cannot be loaded. */
export function suggestionFallbackName(entry: ToolEntry): string | null {
  const given = isFields(entry.structured?.suggestion) ? entry.structured.suggestion : {}
  const fromStructured = text(given.workflow_name) ?? text(given.title)
  if (fromStructured) return fromStructured
  const input = inputOf(entry)
  const fromInput = text(input.title)
  if (fromInput) return fromInput
  const quoted = /"([^"\n]{1,120})"/.exec(resultText(entry))?.[1]
  return text(quoted)
}

/**
 * The call is drawn as its workflow card once it ended: a suggestion or a workflow to keep when it
 * made one (or while a digested output is being restored to inspect it); a draft for a suggestion
 * folds as work.
 */
export function workflowCardOf(entry: ToolEntry): WorkflowTool | null {
  const tool = workflowToolOf(entry)
  if (!tool || entry.permission) return null
  if (tool === 'start') {
    return entry.status === 'completed' && (cardIdOf(entry) || hasDigestedContent(entry))
      ? tool
      : null
  }
  if (tool === 'create' && entry.status === 'completed') {
    return cardIdOf(entry) || savedOf(entry) || hasDigestedContent(entry) ? tool : null
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

/**
 * Whether Edit on a workflow suggestion card can route the user to the session's composer: only
 * while the card waits and the session actually renders a live composer.
 */
export function canEditSuggestion({
  waiting,
  away,
  archived,
  origin,
  worktreeState,
}: {
  waiting: boolean
  away: boolean
  archived: boolean
  origin: SessionSummary['origin'] | undefined
  worktreeState: NonNullable<SessionSummary['worktree']>['state'] | undefined
}): boolean {
  return waiting && !away && !archived && origin !== 'subagent' && worktreeState !== 'gone'
}
