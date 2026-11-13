// Routines and their runs, as each host reports them: this computer's, and those of the other
// hosts it connects to, kept after a host's connection ends so its page shows what was last read.
// The pages read this store.

import { create } from 'zustand'
import type { RoutineList } from '@shared/agent-host'
import {
  isActiveRun,
  type RoutineChanges,
  type RoutineDraft,
  type RoutineRun,
  type RoutineView,
  type RunView,
  type RoutinesProblem,
} from '@shared/routines'
import { errorMessage, host, hostAt, learnRoutineHost, routineHost } from '@renderer/lib/host'
import { otherHosts, useHostsStore } from './hosts'

export interface RunsState {
  items: RunView[]
  /** The cursor of the page before these, or null at the run's first. */
  older: number | null
  loading: boolean
  error: string | null
}

/** The run that ended last, for the pages' live region. */
export interface RunEnding {
  run: RoutineRun
  name: string
}

/** What became of the last read of a host's routines. */
export interface RoutinesRead {
  /** A read finished, or failed. */
  loaded: boolean
  /** A read succeeded once, so the list holds what the host last said. */
  read: boolean
  problem: RoutinesProblem | null
  error: string | null
}

interface OtherRoutines extends RoutinesRead {
  /** The host's routines in the list, in its own order. */
  ids: string[]
}

interface RoutinesStore {
  /** Every host's routines, this computer's first. */
  byId: Record<string, RoutineView>
  order: string[]
  /** This computer's read, as the rest of the window waits for it. */
  loaded: boolean
  /** Set when `routines.json` could not be read; the list is empty and a notice says so. */
  problem: RoutinesProblem | null
  error: string | null
  /** Each other host's read, by its id. */
  others: Record<string, OtherRoutines>
  runs: Record<string, RunsState>
  ending: RunEnding | null
  /** Reads the routines of the host named, null being this computer. */
  load(hostId?: string | null): Promise<void>
  receive(routine: RoutineView, hostId?: string | null): void
  removed(routineId: string, hostId?: string | null): void
  receiveRun(run: RoutineRun, hostId?: string | null): void
  loadRuns(routineId: string, more?: boolean): Promise<void>
  runNow(routineId: string): Promise<RoutineRun>
  /** Creates the routine on the host named, null being this computer. */
  create(draft: RoutineDraft, hostId?: string | null): Promise<RoutineView>
  update(routineId: string, changes: RoutineChanges): Promise<RoutineView>
  remove(routineId: string): Promise<void>
  markSeen(routineId: string): Promise<void>
}

const UNREAD: OtherRoutines = { loaded: false, read: false, problem: null, error: null, ids: [] }

type State = Pick<RoutinesStore, 'byId' | 'order' | 'others' | 'runs'>

/** The ids of the host's routines in the list, null being this computer. */
function idsOn(state: State, hostId: string | null): string[] {
  if (hostId !== null) return state.others[hostId]?.ids ?? []
  return state.order.filter((id) => routineHost(id) === null)
}

/** The list with the host's routines replaced by `routines`, this computer's kept first. */
function withHostList(
  state: State,
  hostId: string | null,
  routines: RoutineView[],
): Pick<State, 'byId' | 'order' | 'runs'> & { ids: string[] } {
  const before = new Set(idsOn(state, hostId))
  const taken = routines.filter((routine) => learnRoutineHost(routine.id, hostId))
  const ids = taken.map((routine) => routine.id)
  const kept = new Set(ids)
  const byId = { ...state.byId }
  const runs = { ...state.runs }
  for (const id of before) {
    if (kept.has(id)) continue
    delete byId[id]
    delete runs[id]
  }
  for (const routine of taken) byId[routine.id] = routine
  const rest = state.order.filter((id) => !before.has(id) && !kept.has(id))
  return { byId, order: hostId === null ? [...ids, ...rest] : [...rest, ...ids], runs, ids }
}

export const useRoutinesStore = create<RoutinesStore>()((set, get) => ({
  byId: {},
  order: [],
  loaded: false,
  problem: null,
  error: null,
  others: {},
  runs: {},
  ending: null,

  async load(hostId = null) {
    try {
      const list: RoutineList = await hostAt(hostId, 'routines.list', undefined)
      set((state) => {
        const { ids, ...lists } = withHostList(state, hostId, list.routines)
        if (hostId === null) return { ...lists, loaded: true, problem: list.problem, error: null }
        const read = { loaded: true, read: true, problem: list.problem, error: null, ids }
        return { ...lists, others: { ...state.others, [hostId]: read } }
      })
    } catch (error) {
      const message = errorMessage(error)
      if (hostId === null) set({ loaded: true, error: message })
      else {
        set((state) => ({
          others: {
            ...state.others,
            [hostId]: { ...(state.others[hostId] ?? UNREAD), loaded: true, error: message },
          },
        }))
      }
    }
  },

  receive(routine, hostId = null) {
    if (!learnRoutineHost(routine.id, hostId)) return
    set((state) => {
      const known = state.order.includes(routine.id)
      const others =
        hostId === null || state.others[hostId]?.ids.includes(routine.id)
          ? state.others
          : {
              ...state.others,
              [hostId]: {
                ...(state.others[hostId] ?? UNREAD),
                ids: [...(state.others[hostId]?.ids ?? []), routine.id],
              },
            }
      return {
        byId: { ...state.byId, [routine.id]: routine },
        order: known ? state.order : [...state.order, routine.id],
        others,
      }
    })
  },

  removed(routineId, hostId = null) {
    // A host removes only its own.
    if (routineHost(routineId) !== hostId) return
    set((state) => {
      const byId = { ...state.byId }
      delete byId[routineId]
      const runs = { ...state.runs }
      delete runs[routineId]
      const own = hostId === null ? undefined : state.others[hostId]
      return {
        byId,
        order: state.order.filter((id) => id !== routineId),
        runs,
        others:
          hostId === null || !own
            ? state.others
            : {
                ...state.others,
                [hostId]: { ...own, ids: own.ids.filter((id) => id !== routineId) },
              },
      }
    })
  },

  receiveRun(run, hostId = null) {
    if (routineHost(run.routineId) !== hostId) return
    set((state) => {
      const routine = state.byId[run.routineId]
      if (!routine) return state
      const wasActive = routine.activeRun?.id === run.id
      const active = isActiveRun(run.status)
        ? run
        : routine.activeRun?.id === run.id
          ? null
          : routine.activeRun
      const ended = !isActiveRun(run.status)
      const lastRun = ended
        ? routine.lastRun?.id === run.id ||
          !routine.lastRun ||
          (run.endedAt ?? 0) >= (routine.lastRun.endedAt ?? 0)
          ? run
          : routine.lastRun
        : routine.lastRun
      const next: RoutineView = { ...routine, activeRun: active, lastRun }
      const cache = state.runs[run.routineId]
      const runs = cache ? { ...state.runs, [run.routineId]: withRun(cache, run) } : state.runs
      return {
        byId: { ...state.byId, [routine.id]: next },
        runs,
        ending: ended && wasActive ? { run, name: routine.name } : state.ending,
      }
    })
  },

  async loadRuns(routineId, more = false) {
    const current = get().runs[routineId]
    if (current?.loading) return
    if (!more) {
      // The runs read before show until the newest arrive.
      set((state) => ({
        runs: {
          ...state.runs,
          [routineId]: {
            items: current?.items ?? [],
            older: current?.older ?? null,
            loading: true,
            error: null,
          },
        },
      }))
    } else {
      if (!current?.older) return
      set((state) => ({
        runs: { ...state.runs, [routineId]: { ...current, loading: true, error: null } },
      }))
    }
    const before = more ? (current?.older ?? undefined) : undefined
    try {
      const page = await host('routines.runs', { routineId, ...(before ? { before } : {}) })
      set((state) => {
        const shown = state.runs[routineId]
        if (!shown) return state
        const seen = new Set((more ? shown.items : []).map((item) => item.id))
        const items = [...(more ? shown.items : []), ...page.runs.filter((r) => !seen.has(r.id))]
        return {
          runs: {
            ...state.runs,
            [routineId]: { items, older: page.older, loading: false, error: null },
          },
        }
      })
    } catch (error) {
      set((state) => {
        const shown = state.runs[routineId]
        if (!shown) return state
        return {
          runs: {
            ...state.runs,
            [routineId]: { ...shown, loading: false, error: errorMessage(error) },
          },
        }
      })
    }
  },

  async runNow(routineId) {
    const run = await host('routines.runNow', { routineId })
    get().receiveRun(run)
    return run
  },

  async create(draft, hostId = null) {
    const routine = await hostAt(hostId, 'routines.create', draft)
    get().receive(routine, hostId)
    return routine
  },

  async update(routineId, changes) {
    // The switch moves at once, and goes back if the host refuses.
    const { enabled } = changes
    const flip = (on: boolean) =>
      set((state) => {
        const shown = state.byId[routineId]
        if (!shown || shown.enabled === on) return state
        return { byId: { ...state.byId, [routineId]: { ...shown, enabled: on } } }
      })
    const was = get().byId[routineId]?.enabled
    if (enabled !== undefined) flip(enabled)
    try {
      const routine = await host('routines.update', { routineId, changes })
      get().receive(routine, routineHost(routineId))
      return routine
    } catch (error) {
      if (enabled !== undefined && was !== undefined) flip(was)
      throw error
    }
  },

  async remove(routineId) {
    await host('routines.delete', { routineId })
    get().removed(routineId, routineHost(routineId))
  },

  async markSeen(routineId) {
    const routine = get().byId[routineId]
    if (!routine) return
    await host('routines.markSeen', { routineId })
    set((state) => {
      const shown = state.byId[routineId]
      if (!shown) return state
      return {
        byId: { ...state.byId, [routineId]: { ...shown, unseen: { failed: 0, ended: 0 } } },
      }
    })
  },
}))

/** Puts a run into a routine's loaded page, replacing it where it is and adding it at the top. */
function withRun(cache: RunsState, run: RoutineRun): RunsState {
  const at = cache.items.findIndex((item) => item.id === run.id)
  if (at >= 0) {
    const items = [...cache.items]
    items[at] = { ...run, session: items[at]!.session }
    return { ...cache, items }
  }
  const newest = cache.items[0]
  const order = run.endedAt ?? run.startedAt ?? run.scheduledFor ?? 0
  const newestOrder = newest ? (newest.endedAt ?? newest.startedAt ?? newest.scheduledFor ?? 0) : -1
  if (newest && order < newestOrder) return cache
  return { ...cache, items: [{ ...run, session: null }, ...cache.items] }
}

/** A routine's page, loaded with its runs. */
export function loadRoutinePage(routineId: string): void {
  const store = useRoutinesStore.getState()
  if (!store.loaded) void store.load()
  void store.loadRuns(routineId)
}

const NOT_READ: RoutinesRead = { loaded: false, read: false, problem: null, error: null }

/** The last read of the host's routines, null being this computer. */
export function routinesRead(
  state: Pick<RoutinesStore, 'loaded' | 'problem' | 'error' | 'others'>,
  hostId: string | null,
): RoutinesRead {
  if (hostId !== null) return state.others[hostId] ?? NOT_READ
  return { loaded: state.loaded, read: state.loaded, problem: state.problem, error: state.error }
}

/** A connection to another host opened: its routines are read again. */
export function routinesHostOpened(hostId: string): void {
  void useRoutinesStore.getState().load(hostId)
}

/**
 * The connection to another host ended: its routines stay as last read while this computer still
 * knows the host, and leave the list once it does not.
 */
export function routinesHostClosed(hostId: string): void {
  if (otherHosts(useHostsStore.getState()).some((h) => h.id === hostId)) return
  useRoutinesStore.setState((state) => {
    const own = state.others[hostId]
    if (!own) return state
    const gone = new Set(own.ids)
    const byId = { ...state.byId }
    const runs = { ...state.runs }
    for (const id of gone) {
      delete byId[id]
      delete runs[id]
    }
    const others = { ...state.others }
    delete others[hostId]
    return { byId, runs, others, order: state.order.filter((id) => !gone.has(id)) }
  })
}
