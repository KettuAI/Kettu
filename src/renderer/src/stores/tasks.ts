// Tasks and their node runs, the SOPs and the tier state, as each host reports them: this
// computer's and those of the other hosts it connects to. A task's host is its project's, which
// its path names. The sidebar, the task page, New session's SOP menu and Settings › SOPs read
// this store.

import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type {
  NodeRunView,
  SopSummary,
  TaskDecision,
  TaskDraft,
  TaskRetry,
  TaskView,
  TierSettings,
  TierState,
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
  /** The node runs of the tasks whose page was opened, newest first. */
  runs: Record<string, Loadable<NodeRunView[]>>
  /** Each host's SOPs, by `hostKey`. */
  sops: Record<string, Loadable<SopSummary[]>>
  /** Each host's tier settings and the agent each tier stands for, by `hostKey`. */
  tiers: Record<string, Loadable<TierState>>
  load(hostId?: string | null): Promise<void>
  receive(task: TaskView): void
  removed(taskId: string, hostId?: string | null): void
  receiveRun(run: NodeRunView): void
  loadTask(taskId: string): Promise<void>
  loadSops(hostId: string | null): Promise<void>
  /** The host's SOPs changed: read again when something has shown them. */
  sopsChanged(hostId: string | null): void
  approveSop(hostId: string | null, id: string, hash: string): Promise<void>
  removeSop(hostId: string | null, id: string): Promise<void>
  loadTiers(hostId: string | null): Promise<void>
  saveTiers(hostId: string | null, tiers: TierSettings): Promise<TierState>
  create(draft: TaskDraft): Promise<TaskView>
  cancel(taskId: string): Promise<void>
  remove(taskId: string): Promise<void>
  decide(decision: TaskDecision): Promise<void>
  retry(retry: TaskRetry): Promise<void>
  markSeen(taskId: string): Promise<void>
  /** The Markdown a run handed in, null for none. */
  document(taskId: string, runId: string): Promise<string | null>
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

function newestFirst(runs: readonly NodeRunView[]): NodeRunView[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt || b.round - a.round)
}

export const useTasksStore = create<TasksStore>()((set, get) => ({
  byId: {},
  reads: {},
  runs: {},
  sops: {},
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
      const items = shown.value.filter((item) => item.id !== run.id)
      items.push(run)
      return { runs: { ...state.runs, [run.taskId]: { ...shown, value: newestFirst(items) } } }
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
          [taskId]: { value: newestFirst(runs), loading: false, error: null },
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

  async loadSops(hostId) {
    const key = hostKey(hostId)
    set((state) => ({
      sops: {
        ...state.sops,
        [key]: { value: state.sops[key]?.value ?? null, loading: true, error: null },
      },
    }))
    try {
      const list = await hostAt(hostId, 'sops.list', undefined)
      set((state) => ({ sops: { ...state.sops, [key]: { ...UNREAD, value: list } } }))
    } catch (error) {
      set((state) => ({
        sops: {
          ...state.sops,
          [key]: {
            value: state.sops[key]?.value ?? null,
            loading: false,
            error: errorMessage(error),
          },
        },
      }))
    }
  },

  sopsChanged(hostId) {
    if (get().sops[hostKey(hostId)]) void get().loadSops(hostId)
  },

  async approveSop(hostId, id, hash) {
    const approved = await hostAt(hostId, 'sops.approve', { id, hash })
    const key = hostKey(hostId)
    set((state) => {
      const shown = state.sops[key]
      if (!shown?.value) return state
      const value = shown.value.map((sop) =>
        sop.source === approved.source && sop.id === approved.id ? approved : sop,
      )
      return { sops: { ...state.sops, [key]: { ...shown, value } } }
    })
  },

  async removeSop(hostId, id) {
    await hostAt(hostId, 'sops.remove', { id })
    await get().loadSops(hostId)
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

  async cancel(taskId) {
    get().receive(await hostAt(hostOfTask(taskId), 'tasks.cancel', { taskId }))
  },

  async remove(taskId) {
    const hostId = hostOfTask(taskId)
    await hostAt(hostId, 'tasks.remove', { taskId })
    get().removed(taskId, hostId)
  },

  async decide(decision) {
    get().receive(await hostAt(hostOfTask(decision.taskId), 'tasks.decide', decision))
  },

  async retry(retry) {
    get().receive(await hostAt(hostOfTask(retry.taskId), 'tasks.retry', retry))
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

  document(taskId, runId) {
    return hostAt(hostOfTask(taskId), 'tasks.document', { runId })
  },
}))

/** Whether the task has ended: done, dropped or cancelled. */
export function taskEnded(task: Pick<TaskView, 'state'>): boolean {
  return task.state === 'done' || task.state === 'dropped' || task.state === 'cancelled'
}

/** Ended tasks leave the sidebar this long after they ended, as archived sessions do. */
export const ENDED_TASK_SHOWN_MS = 3 * 24 * 60 * 60 * 1000

/** Whether the sidebar lists the task: not ended more than three days ago. */
export function taskListed(task: TaskView, now: number): boolean {
  if (!taskEnded(task)) return true
  return now - (task.endedAt ?? task.updatedAt) < ENDED_TASK_SHOWN_MS
}

/**
 * Whether a node session's task is gone, so it is listed as a plain session: its host's tasks
 * were read and hold no such task.
 */
export function sessionTaskGone(
  state: Pick<TasksStore, 'byId' | 'reads'>,
  session: Pick<SessionSummary, 'task' | 'origin' | 'projectPath'>,
): boolean {
  // A node session that names no task has none to be listed under.
  if (!session.task) return session.origin === 'task'
  const read = state.reads[hostKey(hostOfPath(session.projectPath))]
  return !!read?.loaded && !read.error && !state.byId[session.task.taskId]
}

/** A connection to another host opened: its tasks are read again, and its SOPs if shown. */
export function tasksHostOpened(hostId: string): void {
  void useTasksStore.getState().load(hostId)
  useTasksStore.getState().sopsChanged(hostId)
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
    const key = hostKey(hostId)
    const reads = { ...state.reads }
    delete reads[key]
    const sops = { ...state.sops }
    delete sops[key]
    const tiers = { ...state.tiers }
    delete tiers[key]
    return { byId, reads, sops, tiers }
  })
}
