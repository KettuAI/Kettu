// What main follows of one host for the notch island, through the few calls and events the island
// may use: its sessions' summaries, its agents and their options, and the requests of the sessions
// that wait, read only when how many wait changes. It never reads a thread's pages and never says
// a session is in front, so nothing it does marks a session seen.

import type {
  AgentOptions,
  AgentStatus,
  HostEvent,
  HostMethod,
  HostParams,
  HostResult,
  SessionSummary,
} from '@shared/agent-host'
import { pendingRequests, type PendingRequest } from '@shared/pending-requests'
import type { AgentId } from '@shared/thread'
import type { TaskSummary } from '@shared/workflow'
import type { IslandTaskState } from './view'

/** The agent host's methods the island may use, on every host it shows. */
export const ISLAND_HOST_METHODS = [
  'agents.list',
  'agents.options',
  'agents.refreshLimits',
  'sessions.list',
  'sessions.requests',
  // For the titles of the tasks whose steps' rows name them, and the tasks that wait.
  'tasks.list',
  'permissions.respond',
  'browser.answerOrigin',
  'computer.answerApp',
] as const satisfies readonly HostMethod[]

export type IslandHostMethod = (typeof ISLAND_HOST_METHODS)[number]

/** A failed request's message: a port's error object, or an Error. */
export function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

/** A failed request as a log line says it, in English where the error keeps its words that way. */
export function errorLog(error: unknown): string {
  const log = (error as { log?: unknown } | null)?.log
  return typeof log === 'string' ? log : errorText(error)
}

export function isIslandHostMethod(method: string): method is IslandHostMethod {
  return (ISLAND_HOST_METHODS as readonly string[]).includes(method)
}

export type HostRequest = <M extends IslandHostMethod>(
  method: M,
  params: HostParams<M>,
) => Promise<HostResult<M>>

export interface HostFeedDeps {
  request: HostRequest
  /** Something the view shows changed. */
  changed(): void
  warn(message: string): void
}

/** What the island keeps of a task, or null for one it cannot read, as from an older host. */
function taskState(value: unknown): IslandTaskState | null {
  if (typeof value !== 'object' || value === null) return null
  const task = value as Partial<TaskSummary>
  if (typeof task.title !== 'string') return null
  const steps = Array.isArray(task.steps)
    ? task.steps.filter((step) => typeof step?.id === 'string' && typeof step.name === 'string')
    : []
  return {
    title: task.title,
    needsYou: task.needsYou === true && task.status === 'running' && !task.archivedAt,
    steps: steps.map(({ id, name, state, sessionId }) => ({
      id,
      name,
      state,
      sessionId: sessionId ?? null,
    })),
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
  }
}

/** Whether a summary has what the view reads of it, as one from another host may not. */
function readable(value: unknown): value is SessionSummary {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    typeof s.agentId === 'string' &&
    typeof s.projectPath === 'string' &&
    typeof s.status === 'string' &&
    typeof s.attention === 'string' &&
    typeof s.permissionCount === 'number' &&
    typeof s.updatedAt === 'number' &&
    (s.title === null || typeof s.title === 'string')
  )
}

export class HostFeed {
  readonly sessions = new Map<string, SessionSummary>()
  readonly agents = new Map<AgentId, AgentStatus>()
  readonly options = new Map<AgentId, AgentOptions>()
  /** Each task, by id, for the rows of its steps and for what it waits for. */
  readonly tasks = new Map<string, IslandTaskState>()
  readonly requests = new Map<
    string,
    { requests: PendingRequest[]; askedAt: Record<string, number> }
  >()
  /** The count each session's requests were read at, so they are read again once it moves. */
  private readonly readAt = new Map<string, number>()
  private readonly reading = new Set<string>()
  private generation = 0

  constructor(private readonly deps: HostFeedDeps) {}

  /** Reads the host whole, as after connecting; what it held before is dropped. */
  async load(): Promise<void> {
    const generation = ++this.generation
    const { request } = this.deps
    const [sessions, agents, options, tasks] = await Promise.all([
      request('sessions.list', {}),
      request('agents.list', undefined),
      request('agents.options', undefined),
      // A host from before tasks has none to name.
      request('tasks.list', undefined).catch(() => []),
    ])
    if (generation !== this.generation) return
    this.forget()
    for (const summary of sessions) {
      if (readable(summary) && !summary.prepared) this.sessions.set(summary.id, summary)
    }
    for (const agent of agents) this.agents.set(agent.id, agent)
    for (const option of options) this.options.set(option.agentId, option)
    for (const task of tasks) {
      const state = taskState(task)
      if (state && typeof task.id === 'string') this.tasks.set(task.id, state)
    }
    for (const summary of this.sessions.values()) this.follow(summary)
    this.deps.changed()
  }

  /** The host is gone: nothing it said holds, and reads under way are dropped. */
  clear(): void {
    this.generation++
    this.forget()
    this.deps.changed()
  }

  private forget(): void {
    this.sessions.clear()
    this.agents.clear()
    this.options.clear()
    this.tasks.clear()
    this.requests.clear()
    this.readAt.clear()
  }

  event(event: HostEvent): void {
    switch (event.type) {
      case 'session.summary': {
        const { summary } = event
        if (!readable(summary) || summary.prepared) return
        this.sessions.set(summary.id, summary)
        this.follow(summary)
        break
      }
      case 'session.removed':
        this.sessions.delete(event.sessionId)
        this.requests.delete(event.sessionId)
        this.readAt.delete(event.sessionId)
        break
      case 'agent.status':
        this.agents.set(event.status.id, event.status)
        break
      case 'agent.removed':
        this.agents.delete(event.agentId)
        this.options.delete(event.agentId)
        break
      case 'agent.options':
        this.options.set(event.options.agentId, event.options)
        break
      case 'task.changed': {
        const id = (event.task as { id?: unknown } | undefined)?.id
        const state = taskState(event.task)
        if (typeof id !== 'string' || !state) return
        if (JSON.stringify(this.tasks.get(id)) === JSON.stringify(state)) return
        this.tasks.set(id, state)
        break
      }
      case 'task.removed':
        if (!this.tasks.delete(event.taskId)) return
        break
      default:
        return
    }
    this.deps.changed()
  }

  /** Reads a session's requests again, as after an answer that found them settled. */
  reread(sessionId: string): void {
    this.readAt.delete(sessionId)
    const summary = this.sessions.get(sessionId)
    if (summary) this.follow(summary)
  }

  private follow(summary: SessionSummary): void {
    const count = summary.permissionCount
    if (count === 0) {
      this.readAt.delete(summary.id)
      if (this.requests.delete(summary.id)) this.deps.changed()
      return
    }
    if (this.readAt.get(summary.id) === count || this.reading.has(summary.id)) return
    void this.readRequests(summary.id, count)
  }

  private async readRequests(sessionId: string, count: number): Promise<void> {
    const generation = this.generation
    this.reading.add(sessionId)
    try {
      const { entries, askedAt } = await this.deps.request('sessions.requests', { sessionId })
      if (generation !== this.generation || !this.sessions.has(sessionId)) return
      this.readAt.set(sessionId, count)
      this.requests.set(sessionId, { requests: pendingRequests(entries), askedAt: askedAt ?? {} })
      this.deps.changed()
    } catch (error) {
      // Read again only once the count moves, so a host that keeps failing is not asked in a loop.
      this.readAt.set(sessionId, count)
      this.deps.warn(`Could not read the requests of ${sessionId}: ${errorLog(error)}`)
    } finally {
      this.reading.delete(sessionId)
    }
    // The count moved while it was read.
    const latest = this.sessions.get(sessionId)
    if (latest && generation === this.generation) this.follow(latest)
  }
}
