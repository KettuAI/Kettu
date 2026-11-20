// The tasks that run through workflows, as each host reports them: their sidebar summaries, and the
// full view of each task a page or card has read. The host sends the full view on every change.

import { create } from 'zustand'
import type { HostParams, SessionSummary } from '@shared/agent-host'
import type { TaskStepSummary, TaskSummary, TaskView } from '@shared/workflow'
import { errorMessage, hostAt, learnTaskHost, taskHost } from '@renderer/lib/host'
import { useSessionsStore } from './sessions'

interface TasksStore {
  summaries: Record<string, TaskSummary>
  views: Record<string, TaskView>
  /** The host each task runs on, null being this computer. */
  hosts: Record<string, string | null>
  /** This computer's list was read. */
  loaded: boolean
  error: string | null
  /** Reads the tasks of the host named, null being this computer. */
  load(hostId?: string | null): Promise<void>
  /** Reads one task in full, for its page. */
  read(taskId: string): Promise<TaskView>
  receive(view: TaskView, hostId: string | null): void
  removed(taskId: string): void
  /** Starts a task on the host of its project. */
  start(params: HostParams<'tasks.start'>, hostId: string | null): Promise<TaskView>
}

export const useTasksStore = create<TasksStore>()((set, get) => ({
  summaries: {},
  views: {},
  hosts: {},
  loaded: false,
  error: null,
  async load(hostId = null) {
    try {
      const list = await hostAt(hostId, 'tasks.list', undefined)
      set((state) => {
        const summaries = { ...state.summaries }
        const hosts = { ...state.hosts }
        for (const [id, on] of Object.entries(hosts)) {
          if (on === hostId) {
            delete summaries[id]
            delete hosts[id]
          }
        }
        for (const summary of list) {
          summaries[summary.id] = summary
          hosts[summary.id] = hostId
          learnTaskHost(summary.id, hostId)
        }
        return hostId === null
          ? { summaries, hosts, loaded: true, error: null }
          : { summaries, hosts }
      })
    } catch (error) {
      if (hostId === null) set({ loaded: true, error: errorMessage(error) })
    }
  },
  async read(taskId) {
    const view = await hostAt(taskHost(taskId), 'tasks.get', { taskId })
    get().receive(view, taskHost(taskId))
    return view
  },
  receive(view, hostId) {
    learnTaskHost(view.id, hostId)
    set((state) => ({
      summaries: { ...state.summaries, [view.id]: view },
      views: { ...state.views, [view.id]: view },
      hosts: { ...state.hosts, [view.id]: hostId },
    }))
  },
  removed(taskId) {
    set((state) => {
      const summaries = { ...state.summaries }
      const views = { ...state.views }
      const hosts = { ...state.hosts }
      delete summaries[taskId]
      delete views[taskId]
      delete hosts[taskId]
      return { summaries, views, hosts }
    })
  },
  async start(params, hostId) {
    const view = await hostAt(hostId, 'tasks.start', params)
    get().receive(view, hostId)
    return view
  },
}))

/** A connection to another host opened: its tasks are read again. */
export function tasksHostOpened(hostId: string): void {
  void useTasksStore.getState().load(hostId)
}

/** The connection to another host ended: its tasks leave the sidebar. */
export function tasksHostClosed(hostId: string): void {
  useTasksStore.setState((state) => {
    const summaries = { ...state.summaries }
    const views = { ...state.views }
    const hosts = { ...state.hosts }
    for (const [id, on] of Object.entries(state.hosts)) {
      if (on !== hostId) continue
      delete summaries[id]
      delete views[id]
      delete hosts[id]
    }
    return { summaries, views, hosts }
  })
}

/** The task a step's session works for, from its summary. */
export function stepTask(taskId: string | undefined | null): TaskSummary | undefined {
  return taskId ? useTasksStore.getState().summaries[taskId] : undefined
}

/** The tasks a project's group lists: neither pinned nor archived, the latest first. */
export function listedTasks(
  summaries: Record<string, TaskSummary>,
  projectPath: string,
): TaskSummary[] {
  return Object.values(summaries)
    .filter((task) => task.projectPath === projectPath && !task.pinnedAt && !task.archivedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The pinned tasks across the projects, in the order they were pinned. */
export function pinnedTasks(summaries: Record<string, TaskSummary>): TaskSummary[] {
  return Object.values(summaries)
    .filter((task) => !!task.pinnedAt && !task.archivedAt)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
}

/** The latest task a suggestion card in the session started, if any. */
export function taskFrom(
  summaries: Record<string, TaskSummary>,
  sessionId: string,
): TaskSummary | undefined {
  let found: TaskSummary | undefined
  for (const task of Object.values(summaries)) {
    if (task.from?.sessionId !== sessionId) continue
    if (!found || task.createdAt > found.createdAt) found = task
  }
  return found
}

/** The tasks that wait for the person or are stuck, the latest first. */
export function needingTasks(summaries: Record<string, TaskSummary>): TaskSummary[] {
  return Object.values(summaries)
    .filter((task) => !task.archivedAt && task.status === 'running' && task.needsYou)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** A started step under its task's row: its session's id, or the step's own for a person's step. */
export interface StepRow {
  id: string
  step: TaskStepSummary
}

/** The steps that started, in the order they started, as rows under their task. */
export function startedSteps(task: TaskSummary): StepRow[] {
  return task.steps
    .filter((step) => step.rounds > 0 && step.startedAt !== null)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((step) => ({ id: step.sessionId ?? `${task.id}/${step.id}`, step }))
}

/**
 * Whether the main area shows the task's page, one of its steps' sessions or the conversation it
 * started from, `originId`.
 */
export function taskShown(
  main: { kind: string; taskId?: string; sessionId?: string },
  taskId: string,
  byId: Record<string, SessionSummary>,
  originId?: string,
): boolean {
  if (main.kind === 'task') return main.taskId === taskId
  if (main.kind !== 'session' || !main.sessionId) return false
  return main.sessionId === originId || byId[main.sessionId]?.task?.taskId === taskId
}

/** Whether a task's row shows its steps: as the user left it, else while it is in front. */
export function taskExpanded(
  view: {
    main: { kind: string; taskId?: string; sessionId?: string }
    expandedParents: Record<string, boolean>
  },
  taskId: string,
  byId: Record<string, SessionSummary>,
  originId?: string,
): boolean {
  return view.expandedParents[taskId] ?? taskShown(view.main, taskId, byId, originId)
}

/**
 * Reads the summaries of a task's step sessions into the session list, which leaves them out, so
 * their rows show their state and open them.
 */
export async function loadTaskSessions(taskId: string): Promise<void> {
  const summaries = await hostAt(taskHost(taskId), 'tasks.sessions', { taskId })
  const store = useSessionsStore.getState()
  for (const summary of summaries) store.upsert(summary)
}
