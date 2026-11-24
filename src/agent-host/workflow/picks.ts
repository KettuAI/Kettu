// Who does a step: the facts an agent picks from, the checks a pick must pass, and whether a pinned
// or kept person can start now. Kettu checks only what can be told right or wrong, never whether a
// pick is a good one, and never picks itself.

import type { AgentAccount, PlanLimit, RoleSuggests } from '@shared/agent-host'
import type {
  BlockedReason,
  CheckLine,
  Pace,
  PickCheck,
  WorkflowStep,
  StepPick,
  StepTools,
} from '@shared/workflow'
import type { AgentId, HarnessId } from '@shared/thread'
import type { ModelNote } from '../catalog'
import type { TaskRecord } from './model'

/** The harnesses whose permissions Kettu holds, as for routines: only they do steps. */
export const STEP_HARNESSES: ReadonlySet<HarnessId> = new Set(['claude-code', 'codex'])

export interface WorkflowModel {
  value: string
  name: string
  modelId?: string
  note: ModelNote | null
  /** The efforts it offers; null when it offers none or they are not known. */
  efforts: string[] | null
}

/** An agent as the engine sees it when it checks or offers it. */
export interface WorkflowAgent {
  id: AgentId
  name: string
  harness: HarnessId
  disabled: boolean
  /** Removed from Kettu or not installed. */
  missing: boolean
  account: Pick<AgentAccount, 'kind' | 'label' | 'tier'> | null
  /** Paid by the token through an API key, which Auto leaves alone unless allowed. */
  apiKey: boolean
  /** Its sessions get Kettu's MCP server, which a step reports through. */
  kettu: boolean
  /** The models it lists, or null before Kettu has read them. */
  models: WorkflowModel[] | null
  /** The efforts it offers when it lists no models, or null for none. */
  efforts: string[] | null
  /** Its plan limits that hold back `model`. */
  limits(model: string | null): PlanLimit[]
  /**
   * The Skills and MCP servers a step's session of it can be handed, by name: the host's that are
   * installed and on, whichever agents they go to otherwise.
   */
  skills: ReadonlySet<string>
  mcp: ReadonlySet<string>
}

/** The tools a step names that its session could not be handed. */
export function missingTools(agent: WorkflowAgent, tools: StepTools): string[] {
  return [
    ...tools.mcp.filter((name) => !agent.mcp.has(name)),
    ...tools.skills.filter((name) => !agent.skills.has(name)),
  ]
}

/** A step's role and what it suggests, for whoever picks the step's agent. */
export interface RoleHint {
  name: string
  suggests: RoleSuggests
}

export interface PickFacts {
  steps: {
    id: string
    name: string
    prompt: string
    hint: string | null
    tools: StepTools
    /** What the step's role suggests; a hint for the pick, never a pin. */
    role?: RoleHint
    reviews: { stepId: string; name: string; agentId: AgentId; model: string | null }[]
  }[]
  task: { text: string; pace: Pace; paceReason: string | null }
  agents: {
    id: AgentId
    name: string
    harness: HarnessId
    billing: 'subscription' | 'api_key' | 'other'
    account: string | null
    models: {
      value: string
      name: string
      rank: number | null
      price: { input: number; output: number } | null
      note: string | null
      efforts: string[] | null
    }[]
    efforts: string[] | null
    limits: { label: string; usedPercent: number | null; resetsAt: number | null }[]
  }[]
  history: {
    stepId: string
    agentId: AgentId
    model: string | null
    effort: string | null
    runs: number
    medianMinutes: number | null
    sentBack: number
  }[]
}

/** A limit window that is used up now. */
export function reachedLimit(limits: readonly PlanLimit[], now: number): PlanLimit | null {
  return (
    limits.find(
      (limit) => limit.state === 'reached' && (limit.resetsAt === null || limit.resetsAt > now),
    ) ?? null
  )
}

function effortsOf(agent: WorkflowAgent, model: string | null): string[] | null {
  if (agent.models === null || model === null) return agent.efforts
  return agent.models.find((m) => m.value === model)?.efforts ?? agent.efforts
}

/** Why a person cannot do a step now, or null when they can. */
export function blockedFor(
  agent: WorkflowAgent | undefined,
  pick: StepPick,
  step: WorkflowStep,
  now: number,
): BlockedReason | null {
  const unusable = (why: Extract<BlockedReason, { kind: 'unusable' }>['why']): BlockedReason => ({
    kind: 'unusable',
    agentId: pick.agentId,
    why,
  })
  if (!agent || agent.missing) return unusable('removed')
  if (agent.disabled) return unusable('disabled')
  if (!STEP_HARNESSES.has(agent.harness)) return unusable('harness')
  if (!agent.kettu) return unusable('no_kettu')
  const missing = missingTools(agent, step.tools)
  if (missing.length > 0) return { kind: 'tools', missing }
  if (agent.models !== null && pick.model !== null) {
    if (!agent.models.some((m) => m.value === pick.model)) return unusable('model')
  }
  const efforts = effortsOf(agent, pick.model)
  if (efforts !== null && pick.effort !== null && !efforts.includes(pick.effort)) {
    return unusable('effort')
  }
  const reached = reachedLimit(agent.limits(pick.model), now)
  if (reached) return { kind: 'limit', agentId: pick.agentId, resetsAt: reached.resetsAt }
  return null
}

/** The latest done round of each step a review step reviews: who did it. */
export function reviewed(
  task: TaskRecord,
  step: WorkflowStep,
): { stepId: string; agentId: AgentId; model: string | null }[] {
  return step.reviewOf.flatMap((stepId) => {
    const round = task.rounds.findLast((r) => r.stepId === stepId && r.by !== null)
    return round?.by ? [{ stepId, agentId: round.by.agentId, model: round.by.model }] : []
  })
}

export interface PickInput {
  step: string
  agent: string
  model: string | null
  effort: string | null
  reason: string
}

/**
 * Checks one pick. `allowed` says whether Auto may pick an agent; `candidates` are the agents it
 * may pick, for the one exception to a review by the same agent and model.
 */
export function checkPick(
  pick: PickInput,
  step: WorkflowStep,
  task: TaskRecord,
  agents: readonly WorkflowAgent[],
  allowed: (agent: WorkflowAgent) => boolean,
  now: number,
): { lines: CheckLine<PickCheck>[]; reviewShared: boolean } {
  const lines: CheckLine<PickCheck>[] = []
  const line = (check: PickCheck, ok: boolean, detail: string | null = null) =>
    lines.push({ check, ok, detail: ok ? null : detail })
  const agent = agents.find((a) => a.id === pick.agent)
  if (!agent || agent.missing) {
    line('agent', false, `No agent "${pick.agent}" is installed; pick one the facts list.`)
    return { lines, reviewShared: false }
  }
  if (agent.disabled) {
    line('agent', false, `${agent.name} is turned off in Settings.`)
    return { lines, reviewShared: false }
  }
  if (!STEP_HARNESSES.has(agent.harness)) {
    line(
      'agent',
      false,
      `${agent.name} cannot do workflow steps; only Claude Code and Codex agents can.`,
    )
    return { lines, reviewShared: false }
  }
  line('agent', true)
  line('allowed', allowed(agent), `The user does not let Auto pick ${agent.name}.`)
  if (agent.models === null) {
    line(
      'model',
      pick.model === null,
      `Kettu does not know ${agent.name}'s models yet; leave model out.`,
    )
  } else {
    const listed = agent.models.map((m) => m.value)
    line(
      'model',
      pick.model !== null && listed.includes(pick.model),
      `${agent.name} lists these models: ${listed.join(', ')}.`,
    )
  }
  const efforts = effortsOf(agent, pick.model)
  if (efforts === null || efforts.length === 0) {
    line('effort', pick.effort === null, `${agent.name} offers no effort here; leave effort out.`)
  } else {
    // No effort leaves the model's own default.
    line(
      'effort',
      pick.effort === null || efforts.includes(pick.effort),
      `The efforts offered here are: ${efforts.join(', ')}; or leave effort out.`,
    )
  }
  // A tool the host lacks holds the step for the user once picked; no other pick would have it.
  line(
    'tools',
    agent.kettu,
    `Kettu's MCP server is off for ${agent.name}, so it could not report the step.`,
  )
  const reached = reachedLimit(agent.limits(pick.model), now)
  line(
    'limit',
    reached === null,
    reached
      ? `${agent.name}'s ${reached.label} limit is used up` +
          (reached.resetsAt ? ` until ${new Date(reached.resetsAt).toISOString()}.` : '.')
      : null,
  )
  let reviewShared = false
  const same = reviewed(task, step).filter(
    (done) => done.agentId === agent.id && done.model === pick.model,
  )
  if (same.length > 0) {
    // The one exception: no other agent and model may do it.
    const others = agents.some(
      (candidate) =>
        allowed(candidate) &&
        !candidate.disabled &&
        !candidate.missing &&
        STEP_HARNESSES.has(candidate.harness) &&
        candidate.kettu &&
        (candidate.models ?? [{ value: null as string | null }]).some(
          (model) =>
            !reviewed(task, step).some(
              (done) => done.agentId === candidate.id && done.model === model.value,
            ),
        ),
    )
    reviewShared = !others
    line(
      'review',
      reviewShared,
      `${agent.name} with ${pick.model ?? 'its default model'} did the step this one reviews; ` +
        'pick another agent, or another model when no other agent is allowed.',
    )
  } else {
    line('review', true)
  }
  return { lines, reviewShared }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Who did this workflow's step on this host before: runs, median time and times sent back. */
export function historyOf(
  tasks: Iterable<TaskRecord>,
  workflowId: string,
  stepId: string,
): PickFacts['history'] {
  const groups = new Map<
    string,
    { agentId: AgentId; model: string | null; effort: string | null; ms: number[]; back: number }
  >()
  for (const task of tasks) {
    if (task.workflowId !== workflowId) continue
    const rounds = task.rounds.filter((round) => round.stepId === stepId)
    rounds.forEach((round, i) => {
      if (!round.by || round.startedAt === null || round.endedAt === null) return
      if (round.state !== 'done') return
      const key = JSON.stringify([round.by.agentId, round.by.model, round.by.effort])
      const group = groups.get(key) ?? {
        agentId: round.by.agentId,
        model: round.by.model,
        effort: round.by.effort,
        ms: [],
        back: 0,
      }
      group.ms.push(round.endedAt - round.startedAt)
      if (rounds[i + 1]?.sentBack) group.back++
      groups.set(key, group)
    })
  }
  return [...groups.values()].map((group) => {
    const ms = median(group.ms)
    return {
      stepId,
      agentId: group.agentId,
      model: group.model,
      effort: group.effort,
      runs: group.ms.length,
      medianMinutes: ms === null ? null : Math.round(ms / 6_000) / 10,
      sentBack: group.back,
    }
  })
}

/** The facts the reporting agent picks from. */
export function factsFor(
  task: TaskRecord,
  steps: readonly WorkflowStep[],
  agents: readonly WorkflowAgent[],
  allowed: (agent: WorkflowAgent) => boolean,
  history: (stepId: string) => PickFacts['history'],
  roles: ReadonlyMap<string, RoleHint> = new Map(),
): PickFacts {
  const offered = agents.filter(
    (agent) =>
      !agent.disabled && !agent.missing && STEP_HARNESSES.has(agent.harness) && allowed(agent),
  )
  return {
    steps: steps.map((step) => ({
      id: step.id,
      name: step.name,
      prompt: step.prompt,
      hint: step.hint,
      tools: structuredClone(step.tools),
      ...(step.role !== undefined && roles.has(step.role) ? { role: roles.get(step.role)! } : {}),
      reviews: reviewed(task, step).map((done) => ({
        ...done,
        name: task.workflow.steps.find((s) => s.id === done.stepId)?.name ?? done.stepId,
      })),
    })),
    task: { text: task.text, pace: task.pace, paceReason: task.paceReason },
    agents: offered.map((agent) => ({
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      billing: agent.apiKey
        ? 'api_key'
        : agent.account?.kind === 'account'
          ? 'subscription'
          : 'other',
      account: agent.account
        ? [agent.account.label, agent.account.tier].filter(Boolean).join(' ')
        : null,
      models: (agent.models ?? []).map((model) => ({
        value: model.value,
        name: model.name,
        rank: model.note?.rank ?? null,
        price: model.note?.price ?? null,
        note: model.note?.note ?? null,
        efforts: model.efforts,
      })),
      efforts: agent.efforts,
      limits: agent.limits(null).map((limit) => ({
        label: limit.label,
        usedPercent: limit.usedPercent,
        resetsAt: limit.resetsAt,
      })),
    })),
    history: steps.flatMap((step) => history(step.id)),
  }
}
