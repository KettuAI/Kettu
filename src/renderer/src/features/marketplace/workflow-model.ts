// What the Marketplace shows of a workflow: its state, words in the interface's language, the groups
// the directory lists it under, and a step's pin as the agent menu's option values.

import type { AgentOptions } from '@shared/agent-host'
import { harnessOf } from '@shared/agents'
import {
  WORKFLOW_FILE_BYTES,
  isBackArrow,
  workflowText,
  stepName,
  type Workflow,
  type WorkflowEntry,
  type WorkflowOutcome,
  type WorkflowStep,
  type StepPick,
} from '@shared/workflow'
import type { AgentId, ConfigOption } from '@shared/thread'
import { startConfig } from '@renderer/features/session/new-session/start-options'
import { i18n } from '@renderer/lib/i18n'
import type { OptionValues } from '@renderer/stores/agent-options'
import { matchesText } from './model'

/**
 * Whether a workflow can start tasks, and if not, what stands in the way, the most pressing first: a
 * file that does not read, an approval it waits for, or problems found in it.
 */
export type WorkflowState = 'ready' | 'pending' | 'changed' | 'problems' | 'unreadable'

export function workflowState(entry: WorkflowEntry): WorkflowState {
  if (!entry.workflow) return 'unreadable'
  if (entry.approval === 'pending') return 'pending'
  if (entry.approval === 'changed') return 'changed'
  if (entry.problems.length > 0) return 'problems'
  return 'ready'
}

/** Whether the user still has to approve it, the only state Approve clears. */
export function awaitsApproval(entry: WorkflowEntry): boolean {
  return entry.approval === 'pending' || entry.approval === 'changed'
}

/**
 * The directory's groups: Kettu's own, the Kettu Marketplace's, the files the user added, and theirs
 * or an agent's.
 */
export type WorkflowGroup = 'official' | 'community' | 'added' | 'yours'

export function workflowGroup(entry: WorkflowEntry): WorkflowGroup {
  if (entry.source === 'official') return 'official'
  if (entry.source === 'community') return 'community'
  return entry.source === 'github' || entry.source === 'file' ? 'added' : 'yours'
}

/** The listing of the Kettu Marketplace a workflow came from; null for any other. */
export function listingOrigin(
  entry: WorkflowEntry,
): Extract<WorkflowEntry['origin'], { kind: 'community' }> | null {
  return entry.origin?.kind === 'community' ? entry.origin : null
}

export function workflowName(entry: WorkflowEntry, locale: string): string {
  return entry.workflow ? workflowText(entry.workflow, locale).name : entry.name
}

export function workflowDescription(entry: WorkflowEntry, locale: string): string | null {
  return entry.workflow ? workflowText(entry.workflow, locale).description.trim() || null : null
}

/**
 * The steps in order, those an outcome starts at once taken together: Split, then Frontend and
 * Backend side by side, then Integration test.
 */
export function flowGroups(workflow: Workflow): WorkflowStep[][] {
  const together = new Map<string, string[]>()
  for (const step of workflow.steps) {
    for (const outcome of step.outcomes) {
      if (outcome.to.length < 2) continue
      for (const id of outcome.to) together.set(id, outcome.to)
    }
  }
  const placed = new Set<string>()
  const groups: WorkflowStep[][] = []
  for (const step of workflow.steps) {
    if (placed.has(step.id)) continue
    const ids = together.get(step.id) ?? [step.id]
    const group = workflow.steps.filter((s) => ids.includes(s.id) && !placed.has(s.id))
    for (const s of group) placed.add(s.id)
    groups.push(group)
  }
  return groups
}

/** The steps in order, as a row's line says them. */
export function flowLine(workflow: Workflow, locale: string): string {
  return flowGroups(workflow)
    .map((group) => group.map((step) => stepName(workflow, step.id, locale)).join(' + '))
    .join(' → ')
}

export function workflowMatches(entry: WorkflowEntry, query: string, locale: string): boolean {
  return matchesText(
    [
      workflowName(entry, locale),
      entry.name,
      workflowDescription(entry, locale),
      entry.workflow ? flowLine(entry.workflow, locale) : null,
      i18n.t('marketplace:kind.workflow'),
    ],
    query,
  )
}

/** Steps the person answers or reviews, which stop the task until they do. */
export function waitsForYou(step: WorkflowStep): boolean {
  return step.by === 'you' || step.youReview
}

/** Where an outcome goes: the steps it starts, or the task's end. */
export function outcomeTarget(
  workflow: Workflow,
  outcome: WorkflowOutcome,
  locale: string,
): { kind: 'end'; end: 'done' | 'dropped' } | { kind: 'steps'; names: string[] } {
  if (outcome.end) return { kind: 'end', end: outcome.end }
  return { kind: 'steps', names: outcome.to.map((id) => stepName(workflow, id, locale)) }
}

/** Every arrow that sends work back, by the step it leaves from. */
export function backArrowsOf(workflow: Workflow, step: WorkflowStep): WorkflowOutcome[] {
  return step.outcomes.filter((outcome) => isBackArrow(workflow, step.id, outcome))
}

/** The MCP servers and Skills any of its steps is handed. */
export function workflowTools(workflow: Workflow): { mcp: string[]; skills: string[] } {
  const mcp = new Set<string>()
  const skills = new Set<string>()
  for (const step of workflow.steps) {
    for (const name of step.tools.mcp) mcp.add(name)
    for (const name of step.tools.skills) skills.add(name)
  }
  return { mcp: [...mcp], skills: [...skills] }
}

/** The MCP servers and Skills its steps name that the host does not have, from its problems. */
export function missingTools(entry: WorkflowEntry): string[] {
  const names = new Set<string>()
  for (const problem of entry.problems) {
    const at = /^steps\[(\d+)\]\.tools\.(mcp|skills)\[(\d+)\]$/.exec(problem.at)
    const step = at ? entry.workflow?.steps[Number(at[1])] : undefined
    const name = at && step?.tools[at[2] as 'mcp' | 'skills'][Number(at[3])]
    if (name) names.add(name)
  }
  return [...names]
}

/** The repository a GitHub file URL points into, as owner/repo. */
export function githubRepo(url: string): string | null {
  try {
    const parsed = new URL(url)
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean)
    if (!owner || !repo) return null
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'raw.githubusercontent.com') {
      return null
    }
    return `${owner}/${repo}`
  } catch {
    return null
  }
}

/** The page of a GitHub file, for a link: a raw URL turns into its blob page. */
export function githubPage(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'raw.githubusercontent.com') return url
    const [owner, repo, ref, ...rest] = parsed.pathname.split('/').filter(Boolean)
    if (!owner || !repo || !ref) return url
    return `https://github.com/${owner}/${repo}/blob/${ref}/${rest.join('/')}`
  } catch {
    return url
  }
}

/**
 * Whether the host can fetch the text as a workflow file: a file in a GitHub repository, by its page
 * or its raw address, as the host reads them.
 */
export function isWorkflowFileUrl(text: string): boolean {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const parts = url.pathname.split('/').filter(Boolean)
  if (url.hostname === 'raw.githubusercontent.com') return parts.length >= 4
  return url.hostname === 'github.com' && parts.length >= 5 && parts[2] === 'blob'
}

export const WORKFLOW_FILE_KB = WORKFLOW_FILE_BYTES / 1024

// Only these harnesses run steps; the host refuses a pin of any other when the step starts.
const STEP_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex'])

export function runsSteps(agentId: AgentId): boolean {
  return STEP_HARNESSES.has(harnessOf(agentId))
}

function modelOption(entry: AgentOptions): ConfigOption | undefined {
  return entry.config.find((o) => o.category === 'model' && o.type === 'select')
}

function levelOption(entry: AgentOptions, model: string | null): ConfigOption | undefined {
  const own = model === null ? undefined : entry.levels[model]
  return own ?? entry.config.find((o) => o.category === 'thought_level' && o.type === 'select')
}

/** The agent menu's values for a pin: its model and effort under the agent's option ids. */
export function pinValues(entry: AgentOptions | undefined, pick: StepPick): OptionValues {
  if (!entry) return {}
  const values: OptionValues = {}
  const model = modelOption(entry)
  if (model && pick.model !== null) values[model.id] = pick.model
  const level = levelOption(entry, pick.model)
  if (level && pick.effort !== null) values[level.id] = pick.effort
  return values
}

/**
 * The pin the menu's values stand for, with the model and effort the step would start with
 * written out, so the pin says what it runs rather than following the agent's defaults.
 */
export function pinOf(
  entry: AgentOptions | undefined,
  agentId: AgentId,
  values: OptionValues,
  model: string | null = null,
): StepPick {
  if (!entry) return { agentId, model, effort: null }
  const config = startConfig(entry, values)
  const chosen = config.find((o) => o.category === 'model' && o.type === 'select')?.value
  const level = config.find((o) => o.category === 'thought_level' && o.type === 'select')?.value
  return {
    agentId,
    model: typeof chosen === 'string' ? chosen : model,
    effort: typeof level === 'string' ? level : null,
  }
}

/** A pin's model and effort by the names the agent gives them, or their values when unknown. */
export function pinNames(
  entry: AgentOptions | undefined,
  pick: StepPick,
): { model: string | null; effort: string | null } {
  const model = entry ? modelOption(entry) : undefined
  const level = entry ? levelOption(entry, pick.model) : undefined
  const name = (option: ConfigOption | undefined, value: string | null) =>
    value === null ? null : (option?.choices?.find((c) => c.value === value)?.name ?? value)
  return { model: name(model, pick.model), effort: name(level, pick.effort) }
}
