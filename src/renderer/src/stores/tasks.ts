// The tasks that run through SOPs, as each host reports them: their sidebar summaries, and the
// full view of each task a page or card has read. The host sends the full view on every change.

import { create } from 'zustand'
import type { HostParams } from '@shared/agent-host'
import type { TaskSummary, TaskView } from '@shared/sop'
import { errorMessage, hostAt, learnTaskHost, taskHost } from '@renderer/lib/host'

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
