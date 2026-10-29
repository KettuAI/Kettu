// Routines: prompts that Kettu sends, each run a session of its own. See the routines design.

import type { SessionSummary } from './agent-host'
import type { AgentId, StopReason, TokenTotals } from './thread'

/** A run's trigger. Chaining adds kinds of its own later. */
export type RunTrigger = 'schedule' | 'catch-up' | 'manual'

/** When a routine runs. Only `schedule` exists until chaining's triggers do. */
export type Schedule =
  | { kind: 'once'; at: string } // local date and time, 'YYYY-MM-DDTHH:mm'
  | { kind: 'every'; minutes: number; from: number } // elapsed time, counted from an instant
  | { kind: 'weekly'; days: number[]; time: string } // 0 is Sunday; 'HH:mm' local
  | { kind: 'cron'; expression: string } // five fields, local time

/** What a run may do without asking, once the host answers inside it. */
export interface PermissionScope {
  level: 'read' | 'edit' | 'commands'
  web: boolean
}

/** An agent option value a routine starts with, as sessions.create takes it. */
export interface RoutineOption {
  id: string
  value: string | boolean
}

/** The routine and run reference a run's session carries. */
export interface RoutineRef {
  routineId: string
  runId: string
  trigger: RunTrigger
  scheduledFor: number | null // the scheduled time it stands for; null for Run now
}

export interface Routine {
  id: string // 'r-' and 12 hex digits
  name: string // the user's, or the prompt's first line cut to 60 characters
  prompt: string // sent as written
  agentId: AgentId
  projectPath: string | null // null: the routine's own scratch folder
  options: RoutineOption[] // model, model_config and thought_level values
  trigger: { kind: 'schedule'; schedule: Schedule }
  scope: PermissionScope
  timeLimitMinutes: TimeLimitMinutes
  enabled: boolean
  createdAt: number
  updatedAt: number
  checkedThrough: number // every scheduled time up to here has run, been skipped or caught up
}

export const TIME_LIMITS = [15, 30, 60, 120, 240] as const
export type TimeLimitMinutes = (typeof TIME_LIMITS)[number]

export const PROMPT_CHARS = 100_000
export const ROUTINE_NAME_CHARS = 120
export const ROUTINE_NAME_FROM_PROMPT = 60
export const ROUTINE_OPTION_LIMIT = 20
export const ROUTINE_OPTION_CHARS = 200
export const ROUTINE_ID = /^r-[0-9a-f]{12}$/

/** A new routine, as the renderer asks for one; the host adds the rest. */
export type RoutineDraft = Omit<
  Routine,
  'id' | 'createdAt' | 'updatedAt' | 'checkedThrough' | 'enabled'
>

/** What `routines.update` changes: any field of the draft, and the switch. */
export type RoutineChanges = Partial<RoutineDraft> & { enabled?: boolean }

export type RunStatus =
  | 'queued' // due, waiting for a free slot
  | 'starting' // its session is being created
  | 'running'
  | 'waiting' // a permission request beyond its scope waits for the user
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled' // stopped by the user
  | 'interrupted' // stopped by quitting, or by the agent host stopping
  | 'skipped'

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting',
]

export const ENDED_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
]

export const FAILED_RUN_STATUSES: readonly RunStatus[] = ['failed', 'timed_out']

export const isActiveRun = (status: RunStatus): boolean => ACTIVE_RUN_STATUSES.includes(status)
export const isEndedRun = (status: RunStatus): boolean => ENDED_RUN_STATUSES.includes(status)

export interface RoutineRun {
  id: string
  routineId: string
  trigger: RunTrigger
  scheduledFor: number | null
  count: number // scheduled times it stands for: more than 1 for a catch-up or merged skips
  status: RunStatus
  reason: 'overlap' | 'plan_limit' | null // why it was skipped
  sessionId: string | null // null for a skip, and once the session is deleted or removed
  startedAt: number | null
  endedAt: number | null
  workingMs: number // time working, without the time waiting for approval
  stopReason: StopReason | null
  error: { message: string; detail?: string } | null
  output: string | null // the turn's answer, up to 64 KB
  usage: TokenTotals | null
  changedFiles: string[] // paths its edits touched, relative to the project
  seen: boolean
}

/** How many runs of one routine the history reads at a time. */
export const RUNS_PAGE = 50

/** The sessions of each routine's latest runs that are kept. */
export const KEPT_RUN_SESSIONS = 100

/** How many runs work at once across all routines. */
export const WORKING_RUNS = 2

/** The largest output a run keeps, in bytes. */
export const RUN_OUTPUT_BYTES = 64 * 1024

export interface RoutineView extends Routine {
  state: 'on' | 'off' | 'done' | 'paused'
  nextRunAt: number | null // null while off, done or paused
  /** While its agent's plan-limit window is near: that window, which the routine waits out. */
  pause: {
    agentId: AgentId
    window: string // the plan limit's window, such as 'five_hour'
    usedPercent: number | null // null when the window is reached
    resetsAt: number | null // null when the window gives no reset; the pause then lasts an hour
  } | null
  activeRun: RoutineRun | null
  lastRun: RoutineRun | null
  unseen: { failed: number; ended: number } // runs not seen since they ended
  sessions: number // runs that still have a session, for the delete confirmation
}

export interface RunView extends RoutineRun {
  session: SessionSummary | null
}

/** A routine's runs page, newest first, with the cursor of the page before it. */
export interface RunPage {
  runs: RunView[]
  older: number | null
}

/** What the Routines page shows of the routines file when it could not be read. */
export interface RoutinesProblem {
  reason: string
  backup: string | null // the file it was moved to
}

export const DEFAULT_SCHEDULE: Schedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }

export const DEFAULT_SCOPE: PermissionScope = { level: 'read', web: false }

export const DEFAULT_TIME_LIMIT: TimeLimitMinutes = 60

/** Whether a schedule has the fields its kind needs, within the ranges the form allows. */
export function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const schedule = value as Record<string, unknown>
  switch (schedule.kind) {
    case 'once':
      return typeof schedule.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(schedule.at)
    case 'every': {
      const minutes = schedule.minutes
      if (typeof minutes !== 'number' || !Number.isInteger(minutes)) return false
      if (minutes < 5 || minutes > 720) return false
      const from = schedule.from
      return typeof from === 'number' && Number.isFinite(from) && from >= 0
    }
    case 'weekly':
      return (
        Array.isArray(schedule.days) &&
        schedule.days.length > 0 &&
        schedule.days.length <= 7 &&
        schedule.days.every(
          (day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
        ) &&
        new Set(schedule.days).size === schedule.days.length &&
        typeof schedule.time === 'string' &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)
      )
    case 'cron':
      return (
        typeof schedule.expression === 'string' &&
        schedule.expression.trim() !== '' &&
        schedule.expression.length <= 200
      )
    default:
      return false
  }
}

export function isPermissionScope(value: unknown): value is PermissionScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  return (
    (scope.level === 'read' || scope.level === 'edit' || scope.level === 'commands') &&
    typeof scope.web === 'boolean'
  )
}

export function isTimeLimit(value: unknown): value is TimeLimitMinutes {
  return (TIME_LIMITS as readonly unknown[]).includes(value)
}

export function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === 'queued' ||
    value === 'starting' ||
    value === 'running' ||
    value === 'waiting' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'timed_out' ||
    value === 'cancelled' ||
    value === 'interrupted' ||
    value === 'skipped'
  )
}

export function isRunTrigger(value: unknown): value is RunTrigger {
  return value === 'schedule' || value === 'catch-up' || value === 'manual'
}

/** Whether a run record read from storage has every field, as its own type needs. */
export function isRoutineRun(value: unknown): value is RoutineRun {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const run = value as Record<string, unknown>
  const time = (v: unknown): boolean =>
    v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
  return (
    typeof run.id === 'string' &&
    typeof run.routineId === 'string' &&
    isRunTrigger(run.trigger) &&
    time(run.scheduledFor) &&
    typeof run.count === 'number' &&
    isRunStatus(run.status) &&
    (run.reason === null || run.reason === 'overlap' || run.reason === 'plan_limit') &&
    (run.sessionId === null || typeof run.sessionId === 'string') &&
    time(run.startedAt) &&
    time(run.endedAt) &&
    typeof run.workingMs === 'number' &&
    run.workingMs >= 0 &&
    (run.stopReason === null || typeof run.stopReason === 'string') &&
    (run.error === null ||
      (typeof run.error === 'object' &&
        run.error !== null &&
        typeof (run.error as { message?: unknown }).message === 'string')) &&
    (run.output === null || typeof run.output === 'string') &&
    (run.usage === null || typeof run.usage === 'object') &&
    Array.isArray(run.changedFiles) &&
    run.changedFiles.every((path) => typeof path === 'string') &&
    typeof run.seen === 'boolean'
  )
}
