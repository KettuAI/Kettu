import type { AgentStatus, PlanLimit, SessionSummary } from '@shared/agent-host'
import type { PendingPermission, ThreadEntry, ToolEntry } from '@shared/thread'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'

/** Finished sessions the panel lists, the latest first. */
const FINISHED_ROWS = 3
/** Sessions Recent lists while nothing goes on. */
const RECENT_ROWS = 2

/** What the panel shows of a tool: its kind, title, paths and command. */
export type PendingTool = Pick<ToolEntry, 'toolKind' | 'title' | 'locations' | 'rawInput'>

/** A request in a session's thread that waits for the user. */
export type PendingRequest =
  | { kind: 'tool'; entryId: string; tool: PendingTool; permission: PendingPermission }
  | { kind: 'origin'; entryId: string; origin: string }

/** What the panel reads from a session's thread: its requests, current step and changed files. */
export interface SessionDetail {
  /**
   * The summary's `updatedAt` and `permissionCount` the thread was read at, to read it again once
   * either moves: a request settling moves the count alone.
   */
  readAt: number
  readRequests: number
  requests: PendingRequest[]
  /** The tool the agent runs now, if one runs. */
  activity: PendingTool | null
  turnStartedAt: number | null
  /** Files the last turn changed. */
  files: number
}

export interface TrayGroups {
  needsYou: SessionSummary[]
  running: SessionSummary[]
  finished: SessionSummary[]
  recent: SessionSummary[]
}

const newestFirst = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt

/** Whether the panel lists a session at all: the user's own and routines' runs, not sub-agents. */
export function listed(summary: SessionSummary): boolean {
  return summary.archivedAt === null && summary.origin !== 'subagent' && !summary.prepared
}

export function needsYou(summary: SessionSummary): boolean {
  return summary.attention === 'permission' || summary.status === 'awaiting_permission'
}

/**
 * The panel's groups: what waits for the user, what runs, what finished out of view, and while
 * none of these has a session, the latest sessions.
 */
export function groupSessions(summaries: readonly SessionSummary[]): TrayGroups {
  const shown = summaries.filter(listed).sort(newestFirst)
  const waiting = shown.filter(needsYou)
  const running = shown.filter((s) => !needsYou(s) && s.status === 'running')
  const finished = shown
    .filter((s) => !needsYou(s) && s.status !== 'running')
    .filter((s) => s.attention === 'unread' || s.attention === 'error')
    .slice(0, FINISHED_ROWS)
  const busy = waiting.length + running.length + finished.length > 0
  return {
    needsYou: waiting,
    running,
    finished,
    recent: busy ? [] : shown.filter((s) => s.parentId === null).slice(0, RECENT_ROWS),
  }
}

const FILE_KINDS = new Set<ToolEntry['toolKind']>(['edit', 'delete', 'move'])

/** Whether a session moved on since its thread was read. */
export function stale(summary: SessionSummary, detail: SessionDetail | undefined): boolean {
  return detail?.readAt !== summary.updatedAt || detail.readRequests !== summary.permissionCount
}

/** Reads the panel's view of a thread from the entries of its latest page. */
export function readDetail(
  entries: readonly ThreadEntry[],
  turnStartedAt: number | null,
  read: Pick<SessionSummary, 'updatedAt' | 'permissionCount'>,
): SessionDetail {
  const requests: PendingRequest[] = []
  let activity: SessionDetail['activity'] = null
  // The last turn starts at the last message the user sent.
  let turn = 0
  entries.forEach((entry, i) => {
    if (entry.kind === 'user') turn = i
  })
  const files = new Set<string>()
  entries.forEach((entry, i) => {
    if (entry.kind === 'tool') {
      if (entry.permission) {
        requests.push({
          kind: 'tool',
          entryId: entry.id,
          tool: entry,
          permission: entry.permission,
        })
      }
      if (entry.status === 'in_progress' || entry.status === 'pending') activity = entry
      if (i >= turn && entry.status === 'completed' && FILE_KINDS.has(entry.toolKind)) {
        for (const location of entry.locations) files.add(location.path)
        for (const content of entry.content) if (content.type === 'diff') files.add(content.path)
      }
    } else if (entry.kind === 'browser_origin' && entry.decision === null) {
      requests.push({ kind: 'origin', entryId: entry.id, origin: entry.origin })
    }
  })
  return {
    readAt: read.updatedAt,
    readRequests: read.permissionCount,
    requests,
    activity,
    turnStartedAt,
    files: files.size,
  }
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
    // A removed agent keeps its last limits, which nothing reads again.
    if (agent.hidden || agent.registered === false || agent.limits.length === 0) continue
    const limit = tightestLimit(agent.limits, now)
    if (!limit || limit.usedPercent === null) continue
    const plan = agent.account ? planName(agent.name, agent.account.label) : null
    rows.push({ agent, plan, limit })
  }
  return rows
}

/** A turn's time so far in whole minutes, at least one: "4", or hours and minutes past an hour. */
export function elapsed(ms: number): { h: number; m: number } {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  return { h: Math.floor(minutes / 60), m: minutes % 60 }
}
