// The run records the thread worker keeps, and the calls the host makes on them.

import type { RoutineRun } from '@shared/routines'

/** What a routine's runs add up to, for its page and its sidebar row. */
export interface RoutineRunStats {
  /** Runs that still have a session, for the delete confirmation. */
  sessions: number
  /** Failed runs not seen since they ended. */
  unseenFailed: number
  /** Ended runs not seen since they ended. */
  unseenEnded: number
  /** The newest run, or null before the first. */
  last: RoutineRun | null
  /** The run working now or waiting to start, or null. */
  active: RoutineRun | null
}

export interface RoutineCalls {
  /** Adds a run with the routine's next seq, or updates one by its id; returns its seq. */
  put: { params: { routineId: string; run: RoutineRun }; result: { seq: number } }
  /** Newest first, below `before` when given; `older` is the cursor of the next page. */
  page: {
    params: { routineId: string; before: number | null; limit: number }
    result: { runs: RoutineRun[]; older: number | null }
  }
  stats: { params: { routineId: string }; result: RoutineRunStats }
  /**
   * The runs with a session beyond the newest `keep` of them, oldest first: their sessions are
   * removed as a deleted session is.
   */
  beyond: {
    params: { routineId: string; keep: number }
    result: { runId: string; sessionId: string }[]
  }
  /** Every run still queued, starting, running or waiting, across all routines. */
  active: { params: void; result: RoutineRun[] }
  /** The runs whose session is this one, with its session cleared. */
  clearSession: { params: { sessionId: string }; result: RoutineRun[] }
  /** Marks the routine's ended runs seen. */
  markSeen: { params: { routineId: string }; result: null }
  remove: { params: { routineId: string }; result: null }
}

export type RoutineCallName = keyof RoutineCalls

export type RoutineCall = {
  [K in RoutineCallName]: { name: K; params: RoutineCalls[K]['params'] }
}[RoutineCallName]
