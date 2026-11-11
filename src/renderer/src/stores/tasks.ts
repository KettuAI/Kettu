// Tasks and their stage runs, as each host reports them: this computer's and those of the other
// hosts it connects to. A task's host is its project's, which its path names. The sidebar, the
// task page, New session's workflow menu and Settings › Tasks read this store.

import { create } from 'zustand'
import type {
  StageRunView,
  TaskDecision,
  TaskDraft,
  TaskView,
  TierSettings,
  WorkflowSummary,
} from '@shared/tasks'
import { errorMessage, host, hostAt } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { otherHosts, useHostsStore } from './hosts'

export interface Loadable<T> {
  value: T | null
  loading: boolean
  error: string | null
}

const UNREAD = { value: null, loading: false, error: null }

/** What became of the last read of one host's tasks. */
export interface TasksRead {
  loaded: boolean
  error: string | null
}

interface TasksStore {
  byId: Record<string, TaskView>
  /** Each host's last read, by `hostKey`. */
  reads: Record<string, TasksRead>
  /** The stage runs of the tasks whose page was opened, newest first. */
  runs: Record<string, Loadable<StageRunView[]>>
  /** The workflows a project can use, by its path. */
  workflows: Record<string, Loadable<WorkflowSummary[]>>
  /** Each host's tier settings, by `hostKey`. */
  tiers: Record<string, Loadable<TierSettings>>
  load(hostId?: string | null): Promise<void>
  receive(task: TaskView): void
  removed(taskId: string, hostId?: string | null): void
  receiveRun(run: StageRunView): void
  loadTask(taskId: string): Promise<void>
  loadWorkflows(projectPath: string): Promise<void>
  loadTiers(hostId: string | null): Promise<void>
  saveTiers(hostId: string | null, tiers: TierSettings): Promise<TierSettings>
  create(draft: TaskDraft): Promise<TaskView>
  start(taskId: string): Promise<void>
  pause(taskId: string): Promise<void>
  resume(taskId: string): Promise<void>
  cancel(taskId: string): Promise<void>
  decide(decision: TaskDecision): Promise<void>
  markSeen(taskId: string): Promise<void>
}

/** A host's key in the store's per-host maps; this computer has none of its own. */
export function hostKey(hostId: string | null): string {
  return hostId ?? ''
}

/** The host a task is on, null being this computer: its project's. */
export function taskHost(task: Pick<TaskView, 'projectPath'>): string | null {
  return hostOfPath(task.projectPath)
}

function hostOfTask(taskId: string): string | null {
  const task = useTasksStore.getState().byId[taskId]
  return task ? taskHost(task) : null
}

export const useTasksStore = create<TasksStore>()((set, get) => ({
  byId: {},
  reads: {},
  runs: {},
  workflows: {},
  tiers: {},

  async load(hostId = null) {
    const key = hostKey(hostId)
    try {
      const list = await hostAt(hostId, 'tasks.list', undefined)
      set((state) => {
        const byId = Object.fromEntries(
          Object.entries(state.byId).filter(([, task]) => taskHost(task) !== hostId),
        )
        for (const task of list) byId[task.id] = task
        return { byId, reads: { ...state.reads, [key]: { loaded: true, error: null } } }
      })
    } catch (error) {
      set((state) => ({
        reads: { ...state.reads, [key]: { loaded: true, error: errorMessage(error) } },
      }))
    }
  },

  receive(task) {
    set((state) => ({ byId: { ...state.byId, [task.id]: task } }))
  },

  removed(taskId, hostId = null) {
    set((state) => {
      const task = state.byId[taskId]
      // A host removes only its own.
      if (!task || taskHost(task) !== hostId) return state
      const byId = { ...state.byId }
      delete byId[taskId]
      const runs = { ...state.runs }
      delete runs[taskId]
      return { byId, runs }
    })
  },

  receiveRun(run) {
    set((state) => {
      const shown = state.runs[run.taskId]
      if (!shown?.value) return state
      const at = shown.value.findIndex((item) => item.id === run.id)
      const items = [...shown.value]
      if (at >= 0) items[at] = run
      else items.unshift(run)
      items.sort((a, b) => b.startedAt - a.startedAt)
      return { runs: { ...state.runs, [run.taskId]: { ...shown, value: items } } }
    })
  },

  async loadTask(taskId) {
    set((state) => ({
      runs: {
        ...state.runs,
        [taskId]: { value: state.runs[taskId]?.value ?? null, loading: true, error: null },
      },
    }))
    try {
      const { task, runs } = await hostAt(hostOfTask(taskId), 'tasks.get', { taskId })
      set((state) => ({
        byId: { ...state.byId, [task.id]: task },
        runs: {
          ...state.runs,
          [taskId]: {
            value: [...runs].sort((a, b) => b.startedAt - a.startedAt),
            loading: false,
            error: null,
          },
        },
      }))
    } catch (error) {
      set((state) => ({
        runs: {
          ...state.runs,
          [taskId]: {
            value: state.runs[taskId]?.value ?? null,
            loading: false,
            error: errorMessage(error),
          },
        },
      }))
    }
  },

  async loadWorkflows(projectPath) {
    set((state) => ({
      workflows: {
        ...state.workflows,
        [projectPath]: {
          value: state.workflows[projectPath]?.value ?? null,
          loading: true,
          error: null,
        },
      },
    }))
    try {
      const list = await host('tasks.workflows', { projectPath })
      set((state) => ({
        workflows: {
          ...state.workflows,
          [projectPath]: { value: list, loading: false, error: null },
        },
      }))
    } catch (error) {
      set((state) => ({
        workflows: {
          ...state.workflows,
          [projectPath]: { value: null, loading: false, error: errorMessage(error) },
        },
      }))
    }
  },

  async loadTiers(hostId) {
    const key = hostKey(hostId)
    set((state) => ({
      tiers: {
        ...state.tiers,
        [key]: { value: state.tiers[key]?.value ?? null, loading: true, error: null },
      },
    }))
    try {
      const tiers = await hostAt(hostId, 'tasks.tiers', undefined)
      set((state) => ({ tiers: { ...state.tiers, [key]: { ...UNREAD, value: tiers } } }))
    } catch (error) {
      set((state) => ({
        tiers: {
          ...state.tiers,
          [key]: {
            value: state.tiers[key]?.value ?? null,
            loading: false,
            error: errorMessage(error),
          },
        },
      }))
    }
  },

  async saveTiers(hostId, tiers) {
    const saved = await hostAt(hostId, 'tasks.setTiers', tiers)
    set((state) => ({ tiers: { ...state.tiers, [hostKey(hostId)]: { ...UNREAD, value: saved } } }))
    return saved
  },

  async create(draft) {
    const task = await host('tasks.create', draft)
    get().receive(task)
    return task
  },

  async start(taskId) {
    get().receive(await hostAt(hostOfTask(taskId), 'tasks.start', { taskId }))
  },

  async pause(taskId) {
    get().receive(await hostAt(hostOfTask(taskId), 'tasks.pause', { taskId }))
  },

  async resume(taskId) {
    get().receive(await hostAt(hostOfTask(taskId), 'tasks.resume', { taskId }))
  },

  async cancel(taskId) {
    get().receive(await hostAt(hostOfTask(taskId), 'tasks.cancel', { taskId }))
  },

  async decide(decision) {
    get().receive(await hostAt(hostOfTask(decision.taskId), 'tasks.decide', decision))
  },

  async markSeen(taskId) {
    const task = get().byId[taskId]
    if (!task) return
    await hostAt(taskHost(task), 'tasks.markSeen', { taskId })
    set((state) => {
      const shown = state.byId[taskId]
      if (!shown) return state
      return { byId: { ...state.byId, [taskId]: { ...shown, lastViewedAt: Date.now() } } }
    })
  },
}))

/** Done and cancelled tasks leave the sidebar this long after they ended, as archived sessions do. */
export const ENDED_TASK_SHOWN_MS = 3 * 24 * 60 * 60 * 1000

/** Whether the sidebar lists the task: not done or cancelled more than three days ago. */
export function taskListed(task: TaskView, now: number): boolean {
  if (task.state !== 'done' && task.state !== 'cancelled') return true
  return now - (task.endedAt ?? task.updatedAt) < ENDED_TASK_SHOWN_MS
}

/** A connection to another host opened: its tasks are read again. */
export function tasksHostOpened(hostId: string): void {
  void useTasksStore.getState().load(hostId)
}

/**
 * The connection to another host ended: its tasks stay as last read while this computer still
 * knows the host, and leave once it does not.
 */
export function tasksHostClosed(hostId: string): void {
  if (otherHosts(useHostsStore.getState()).some((h) => h.id === hostId)) return
  useTasksStore.setState((state) => {
    const byId = Object.fromEntries(
      Object.entries(state.byId).filter(([, task]) => taskHost(task) !== hostId),
    )
    const reads = { ...state.reads }
    delete reads[hostKey(hostId)]
    const tiers = { ...state.tiers }
    delete tiers[hostKey(hostId)]
    return { byId, reads, tiers }
  })
}
