// Routines and their runs, as the host reports them; the pages read this store.

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
import { errorMessage, host } from '@renderer/lib/host'

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

interface RoutinesStore {
  byId: Record<string, RoutineView>
  order: string[]
  loaded: boolean
  /** Set when `routines.json` could not be read; the list is empty and a notice says so. */
  problem: RoutinesProblem | null
  error: string | null
  runs: Record<string, RunsState>
  ending: RunEnding | null
  load(): Promise<void>
  receive(routine: RoutineView): void
  removed(routineId: string): void
  receiveRun(run: RoutineRun): void
  loadRuns(routineId: string, more?: boolean): Promise<void>
  runNow(routineId: string): Promise<RoutineRun>
  create(draft: RoutineDraft): Promise<RoutineView>
  update(routineId: string, changes: RoutineChanges): Promise<RoutineView>
  remove(routineId: string): Promise<void>
  markSeen(routineId: string): Promise<void>
}

export const useRoutinesStore = create<RoutinesStore>()((set, get) => ({
  byId: {},
  order: [],
  loaded: false,
  problem: null,
  error: null,
  runs: {},
  ending: null,

  async load() {
    try {
      const list: RoutineList = await host('routines.list', undefined)
      set({
        byId: Object.fromEntries(list.routines.map((routine) => [routine.id, routine])),
        order: list.routines.map((routine) => routine.id),
        loaded: true,
        problem: list.problem,
        error: null,
      })
    } catch (error) {
      set({ loaded: true, error: errorMessage(error) })
    }
  },

  receive(routine) {
    set((state) => ({
      byId: { ...state.byId, [routine.id]: routine },
      order: state.order.includes(routine.id) ? state.order : [...state.order, routine.id],
    }))
  },

  removed(routineId) {
    set((state) => {
      const byId = { ...state.byId }
      delete byId[routineId]
      const runs = { ...state.runs }
      delete runs[routineId]
      return {
        byId,
        order: state.order.filter((id) => id !== routineId),
        runs,
      }
    })
  },

  receiveRun(run) {
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
      set((state) => ({
        runs: {
          ...state.runs,
          [routineId]: { items: [], older: null, loading: true, error: null },
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

  async create(draft) {
    const routine = await host('routines.create', draft)
    get().receive(routine)
    return routine
  },

  async update(routineId, changes) {
    const routine = await host('routines.update', { routineId, changes })
    get().receive(routine)
    return routine
  },

  async remove(routineId) {
    await host('routines.delete', { routineId })
    get().removed(routineId)
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
