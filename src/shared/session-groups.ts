// What needs the user across sessions, as the menu bar panel and the notch island list it: the
// groups of sessions, the plan limits worth a line, and the window that holds a session back.

import type { AgentOptions, AgentStatus, PlanLimit, SessionSummary } from './agent-host'
import { limitsForModel } from './plan-limits'
import type { AgentId, ConfigOption } from './thread'

/** Finished sessions the menu bar panel lists, the latest first. */
const FINISHED_ROWS = 3
/** Sessions the menu bar panel's Recent lists while nothing goes on. */
const RECENT_ROWS = 2

export interface SessionGroups {
  needsYou: SessionSummary[]
  running: SessionSummary[]
  finished: SessionSummary[]
  /** The latest sessions, while none of the other groups has one. */
  recent: SessionSummary[]
}

const newestFirst = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

/** Whether a session is listed at all: the user's own and routines' runs, not sub-agents. */
export function listed(summary: SessionSummary): boolean {
  return summary.archivedAt === null && summary.origin !== 'subagent' && !summary.prepared
}

export function needsYou(summary: SessionSummary): boolean {
  return summary.attention === 'permission' || summary.status === 'awaiting_permission'
}

/** Whether a sub-agent is at work: starting, running or waiting for an answer. */
export function subagentRunning(child: Pick<SessionSummary, 'status'>): boolean {
  return (
    child.status === 'running' ||
    child.status === 'awaiting_permission' ||
    child.status === 'starting'
  )
}

/** How many of a session's own sub-agents are at work; archived ones are not counted. */
export function runningSubagents(summaries: Iterable<SessionSummary>, parentId: string): number {
  let running = 0
  for (const s of summaries) {
    if (s.origin === 'subagent' && s.parentId === parentId && !s.archivedAt && subagentRunning(s)) {
      running++
    }
  }
  return running
}

/**
 * The groups: what waits for the user, what runs, what finished out of view, and while none of
 * these has a session, the latest sessions. `finished` and `recent` cap their groups.
 */
export function groupSessions(
  summaries: readonly SessionSummary[],
  rows: { finished?: number; recent?: number } = {},
): SessionGroups {
  const shown = summaries.filter(listed).sort(newestFirst)
  const waiting = shown.filter(needsYou)
  const running = shown.filter((s) => !needsYou(s) && s.status === 'running')
  const finished = shown
    .filter((s) => !needsYou(s) && s.status !== 'running')
    .filter((s) => s.attention === 'unread' || s.attention === 'error')
    .slice(0, rows.finished ?? FINISHED_ROWS)
  const busy = waiting.length + running.length + finished.length > 0
  return {
    needsYou: waiting,
    running,
    finished,
    recent: busy
      ? []
      : shown.filter((s) => s.parentId === null).slice(0, rows.recent ?? RECENT_ROWS),
  }
}

/**
 * The window to show for an agent: a reached one first, then the fullest. A window whose reset
 * time has passed is skipped, because its percentage is from before the reset.
 */
export function tightestLimit(limits: readonly PlanLimit[], now: number): PlanLimit | null {
  const current = limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
  const reached = current.find((l) => l.state === 'reached')
  if (reached) return reached
  const known = current.filter((l) => l.usedPercent !== null)
  const fullest = known.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0]
  return fullest ?? current[0] ?? null
}

/**
 * The agents whose plan limits are worth reading when a surface that lists them opens: added,
 * already running and able to report them, so that no agent starts just for the read.
 */
export function limitReaders(agents: readonly AgentStatus[]): AgentId[] {
  return agents
    .filter(
      (a) => a.registered !== false && !a.disabled && a.state === 'ready' && a.capabilities.reports,
    )
    .map((a) => a.id)
}

/** The plan beside the agent, without the word they share: "Claude Max" for Claude Code is "Max". */
export function planName(agentName: string, label: string): string {
  const [first] = agentName.split(/\s+/)
  const words = label.split(/\s+/)
  if (words.length > 1 && first && words[0]!.toLowerCase() === first.toLowerCase()) {
    return words.slice(1).join(' ')
  }
  return label
}

export interface LimitRow {
  agent: AgentStatus
  /** The plan's name, null while the agent names no account. */
  plan: string | null
  limit: PlanLimit
}

/** One row per added agent on a plan: its tightest window that reports how full it is. */
export function limitRows(agents: readonly AgentStatus[], now: number): LimitRow[] {
  const rows: LimitRow[] = []
  for (const agent of agents) {
    // A removed or turned-off agent keeps its last limits, which nothing reads again.
    if (agent.hidden || agent.disabled || agent.registered === false || agent.limits.length === 0) {
      continue
    }
    const limit = tightestLimit(agent.limits, now)
    if (!limit || limit.usedPercent === null) continue
    const plan = agent.account ? planName(agent.name, agent.account.label) : null
    rows.push({ agent, plan, limit })
  }
  return rows
}

/** The agent's model option at the model a session chose, for its name and its own limits. */
export function sessionModel(
  options: AgentOptions | undefined,
  model: string | null,
): ConfigOption | undefined {
  const option = options?.config.find((o) => o.category === 'model')
  if (!option || model === null) return undefined
  return { ...option, value: model }
}

/**
 * The used-up window that holds a session back: one of its agent's that counts on the session's
 * model and has not reset yet, unless extra usage covers it; null when none does.
 */
export function reachedLimit(
  agent: AgentStatus | undefined,
  model: ConfigOption | undefined,
  now: number,
): PlanLimit | null {
  if (!agent) return null
  return (
    limitsForModel(agent.limits, model).find(
      (l) => l.state === 'reached' && !l.extraUsage && (l.resetsAt === null || l.resetsAt > now),
    ) ?? null
  )
}

/** A turn's time so far in whole minutes, at least one: "4", or hours and minutes past an hour. */
export function elapsed(ms: number): { h: number; m: number } {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  return { h: Math.floor(minutes / 60), m: minutes % 60 }
}
