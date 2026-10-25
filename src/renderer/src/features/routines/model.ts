// How routines, their schedules and their runs read in the interface.

import type { AgentOptions, Project } from '@shared/agent-host'
import {
  FAILED_RUN_STATUSES,
  type Routine,
  type RoutineOption,
  type RoutineRun,
  type RoutineView,
  type Schedule,
} from '@shared/routines'
import type { AgentId } from '@shared/thread'
import { startConfig, startValues } from '@renderer/features/session/new-session/start-options'
import { duration, limitLabel } from '@renderer/lib/format'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import type { OptionValues } from '@renderer/stores/agent-options'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { scheduleWords as sharedScheduleWords } from '@shared/schedule'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const formatters = new Map<string, ReturnType<typeof makeFormatters>>()

function makeFormatters(locale: string) {
  return {
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
    monthDay: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    monthDayYear: new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }),
    clock: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
  }
}

function format(): ReturnType<typeof makeFormatters> {
  const locale = i18n.language
  let made = formatters.get(locale)
  if (!made) formatters.set(locale, (made = makeFormatters(locale)))
  return made
}

/** A schedule in words: "Weekdays at 9:00 AM", "Every 2 hours", "Cron 0 9 * * 1". */
export function scheduleWords(schedule: Schedule): string {
  const translate = i18n.t.bind(i18n) as (
    key: string,
    params?: Record<string, string | number>,
  ) => string
  return sharedScheduleWords(
    schedule,
    (key, params) => translate(`routines:${key}`, params),
    currentLocale(),
  )
}

export function clockTime(at: number): string {
  return format().clock.format(at)
}

/** A time as a sentence names it: "Today, 9:00 AM", "Tomorrow, 9:00 AM", "Mon, 9:00 AM". */
export function dayTime(at: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(at) - day(now)) / DAY)
  const time = format().clock.format(at)
  if (days === 0) return i18n.t('routines:when.today', { time })
  if (days === 1) return i18n.t('routines:when.tomorrow', { time })
  if (days > 1 && days <= 6) {
    return i18n.t('routines:when.weekday', { weekday: format().weekday.format(at), time })
  }
  const date =
    new Date(at).getFullYear() === new Date(now).getFullYear()
      ? format().monthDay.format(at)
      : format().monthDayYear.format(at)
  return i18n.t('routines:when.date', { date, time })
}

/** How far ahead a time is: "in 14 h", "in 25 min", "in 3 days". */
export function untilTime(at: number, now = Date.now()): string {
  const delta = Math.max(0, at - now)
  if (delta < HOUR) {
    return i18n.t('time.inMinutes', { count: Math.max(1, Math.floor(delta / MINUTE)) })
  }
  if (delta < DAY) return i18n.t('time.inHours', { count: Math.round(delta / HOUR) })
  return i18n.t('time.inDays', { count: Math.round(delta / DAY) })
}

/** A run's time: when it was due, or when it started for Run now. */
export function runTime(run: RoutineRun, now = Date.now()): string | null {
  if (run.trigger === 'manual') return run.startedAt === null ? null : dayTime(run.startedAt, now)
  const at = run.scheduledFor ?? run.startedAt
  return at === null ? null : dayTime(at, now)
}

/** "Run now", "Catch-up" or "Scheduled", after a run's time. */
export function runTrigger(run: RoutineRun): string | null {
  if (run.trigger === 'manual') return i18n.t('routines:trigger.manual')
  if (run.trigger === 'catch-up') return i18n.t('routines:trigger.catchUp')
  return null
}

/** What became of a run, or what it is doing. */
export function runStatus(run: RoutineRun): string {
  switch (run.status) {
    case 'starting':
      return i18n.t('routines:run.starting')
    case 'running':
      return i18n.t('routines:run.running')
    case 'waiting':
      return i18n.t('routines:run.waiting')
    case 'queued':
      return i18n.t('routines:run.queued')
    case 'succeeded':
      return i18n.t('routines:run.succeeded')
    case 'failed':
      return run.error?.message || i18n.t('routines:run.failed')
    case 'timed_out':
      return run.error?.message || i18n.t('routines:run.timedOut')
    case 'cancelled':
      return i18n.t('routines:run.cancelled')
    case 'interrupted':
      return i18n.t('routines:run.interrupted')
    case 'skipped':
      return run.reason === 'plan_limit'
        ? i18n.t('routines:run.skippedLimit')
        : i18n.t('routines:run.skippedOverlap')
  }
}

/** Why a run failed, else the first line of its output, else what became of it. */
export function runSummary(run: RoutineRun): string {
  // A failed run's partial answer says less than its error.
  if (run.status === 'failed' || run.status === 'timed_out') return runStatus(run)
  const output = run.output ? firstLine(run.output) : ''
  return output || runStatus(run)
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? ''
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .slice(0, 200)
}

/** How long a run worked, or has waited, at the meta role. */
export function runDuration(run: RoutineRun, now = Date.now()): string | null {
  if (run.startedAt === null) return null
  if (run.endedAt !== null) return duration(run.workingMs)
  if (run.status === 'waiting') {
    return i18n.t('routines:run.waited', {
      duration: duration(Math.max(0, now - run.startedAt - run.workingMs)),
    })
  }
  if (run.status === 'starting' || run.status === 'running') {
    return i18n.t('routines:run.working', {
      duration: duration(Math.max(0, now - run.startedAt)),
    })
  }
  return null
}

export function failedRun(run: RoutineRun | null): boolean {
  return !!run && FAILED_RUN_STATUSES.includes(run.status)
}

export type RoutinePause = NonNullable<RoutineView['pause']>

export type RoutineState =
  | { kind: 'waiting' }
  | { kind: 'running'; status: 'starting' | 'running' }
  | { kind: 'queued' }
  | { kind: 'off' }
  | { kind: 'done' }
  | { kind: 'paused'; pause: RoutinePause | null }
  | { kind: 'next'; at: number }
  | { kind: 'on' }

/** What a routine is doing, by the priority its row and page show: its run first. */
export function routineState(routine: RoutineView): RoutineState {
  const active = routine.activeRun
  if (active?.status === 'waiting') return { kind: 'waiting' }
  if (active?.status === 'starting' || active?.status === 'running') {
    return { kind: 'running', status: active.status }
  }
  if (active?.status === 'queued') return { kind: 'queued' }
  if (routine.state === 'off') return { kind: 'off' }
  if (routine.state === 'done') return { kind: 'done' }
  if (routine.state === 'paused') return { kind: 'paused', pause: routine.pause }
  if (routine.nextRunAt !== null) return { kind: 'next', at: routine.nextRunAt }
  return { kind: 'on' }
}

/** A routine's state as a sentence, for its page under the name. */
export function stateText(routine: RoutineView, now = Date.now()): string {
  const state = routineState(routine)
  switch (state.kind) {
    case 'waiting':
      return i18n.t('routines:state.waiting')
    case 'running':
      return i18n.t(
        state.status === 'starting' ? 'routines:state.starting' : 'routines:state.running',
      )
    case 'queued':
      return i18n.t('routines:state.queued')
    case 'off':
      return i18n.t('routines:state.off')
    case 'done':
      return i18n.t('routines:state.done')
    case 'paused':
      return pausedText(state.pause, now)
    case 'next':
      return i18n.t('routines:state.next', {
        when: dayTime(state.at, now),
        away: untilTime(state.at, now),
      })
    case 'on':
      return i18n.t('routines:state.on')
  }
}

/** A routine's state at its row's end: when a pause ends, else as its page says it. */
export function rowStateText(routine: RoutineView, now = Date.now()): string {
  const state = routineState(routine)
  if (state.kind !== 'paused') return stateText(routine, now)
  if (state.pause?.resetsAt == null) return i18n.t('routines:state.paused')
  const { day, time } = pauseEnd(state.pause.resetsAt, now)
  return day === null
    ? i18n.t('routines:state.resumes', { time })
    : i18n.t('routines:state.resumesDay', { day, time })
}

/** "Paused until 2:30 PM: Claude Code's 5-hour limit is 92% used", under a routine's name. */
function pausedText(pause: RoutinePause | null, now: number): string {
  if (!pause) return i18n.t('routines:state.paused')
  const reason = pauseReason(pause)
  if (pause.resetsAt === null) return i18n.t('routines:state.pausedFor', { reason })
  const { day, time } = pauseEnd(pause.resetsAt, now)
  return day === null
    ? i18n.t('routines:state.pausedUntil', { time, reason })
    : i18n.t('routines:state.pausedUntilDay', { day, time, reason })
}

function pauseReason(pause: RoutinePause): string {
  const agent = agentName(pause.agentId)
  const limit = pauseWindow(pause)
  return pause.usedPercent === null
    ? i18n.t('routines:pause.reached', { agent, limit })
    : i18n.t('routines:pause.used', { agent, limit, percent: Math.round(pause.usedPercent) })
}

/** The paused agents among the routines, each with its pause, for the Routines page's notices. */
export function agentPauses(routines: RoutineView[]): RoutinePause[] {
  const pauses = new Map<AgentId, RoutinePause>()
  for (const routine of routines) {
    const pause = routine.state === 'paused' ? routine.pause : null
    if (pause && !pauses.has(pause.agentId)) pauses.set(pause.agentId, pause)
  }
  return [...pauses.values()]
}

/** A pause's notice: the window, its use, and when the routines resume. */
export function pauseNotice(pause: RoutinePause, now = Date.now()): string {
  const limit = pauseWindow(pause)
  const use =
    pause.usedPercent === null
      ? i18n.t('routines:pause.limitReached', { limit })
      : i18n.t('routines:pause.limitUsed', { limit, percent: Math.round(pause.usedPercent) })
  if (pause.resetsAt === null) return use
  const { day, time } = pauseEnd(pause.resetsAt, now)
  const resume =
    day === null
      ? i18n.t('routines:pause.resumes', { time })
      : i18n.t('routines:pause.resumesDay', { day, time })
  return i18n.t('routines:pause.notice', { use, resume })
}

/** The window a pause names, by the label the agent's limits give it. */
function pauseWindow(pause: RoutinePause): string {
  const limit = useAgentsStore
    .getState()
    .byId[pause.agentId]?.limits.find((known) => known.window === pause.window)
  return limitLabel(limit ?? { window: pause.window, label: pause.window })
}

/** When a pause ends: the time, with the weekday or the date when it is not today. */
function pauseEnd(at: number, now: number): { day: string | null; time: string } {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(at) - day(now)) / DAY)
  const time = format().clock.format(at)
  if (days === 0) return { day: null, time }
  const date = days > 0 && days <= 6 ? format().weekday.format(at) : format().monthDay.format(at)
  return { day: date, time }
}

/** The routines under On, by their next run; those without one, by name. */
export function onRoutines(routines: RoutineView[]): RoutineView[] {
  return routines
    .filter((routine) => routine.state !== 'off' && routine.state !== 'done')
    .sort(
      (a, b) =>
        (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name),
    )
}

/** The routines under Off, by name, with done one-time routines last. */
export function offRoutines(routines: RoutineView[]): RoutineView[] {
  const done = (routine: RoutineView) => (routine.state === 'done' ? 1 : 0)
  return routines
    .filter((routine) => routine.state === 'off' || routine.state === 'done')
    .sort((a, b) => done(a) - done(b) || a.name.localeCompare(b.name))
}

/** A routine's strongest signal for the sidebar row, in a session row's priorities. */
export type RoutineSignal =
  { kind: 'waiting'; count: number } | { kind: 'failed' } | { kind: 'running' } | { kind: 'unread' }

export function strongestSignal(routines: RoutineView[]): RoutineSignal | null {
  let waiting = 0
  let failed = false
  let running = false
  let unread = false
  for (const routine of routines) {
    if (routine.activeRun?.status === 'waiting') waiting++
    if (routine.unseen.failed > 0) failed = true
    if (routine.activeRun?.status === 'starting' || routine.activeRun?.status === 'running') {
      running = true
    }
    if (routine.unseen.ended > 0) unread = true
  }
  if (waiting > 0) return { kind: 'waiting', count: waiting }
  if (failed) return { kind: 'failed' }
  if (running) return { kind: 'running' }
  if (unread) return { kind: 'unread' }
  return null
}

/** What the sidebar row says it shows, in words. */
export function signalText(signal: RoutineSignal): string {
  switch (signal.kind) {
    case 'waiting':
      return i18n.t('routines:signal.waiting', { count: signal.count })
    case 'failed':
      return i18n.t('routines:signal.failed')
    case 'running':
      return i18n.t('routines:signal.running')
    case 'unread':
      return i18n.t('routines:signal.unread')
  }
}

/** The values a routine's options stand for, as the agent menu reads them. */
export function optionValues(options: RoutineOption[]): OptionValues {
  return Object.fromEntries(options.map((option) => [option.id, option.value]))
}

/** The model, model config and thought level values a routine saves for its agent. */
export function routineOptions(entry: AgentOptions, values: OptionValues): RoutineOption[] {
  const wanted = startValues(entry, values)
  const kept = new Set(['model', 'model_config', 'thought_level'])
  return startConfig(entry, values)
    .filter((option) => kept.has(option.category) && wanted[option.id] !== undefined)
    .map((option) => ({ id: option.id, value: wanted[option.id]! }))
}

/** The project a routine's runs work in, or null for its own scratch folder. */
export function routineProject(
  routine: Pick<Routine, 'projectPath'>,
  projects: readonly Project[],
): Project | null {
  return routine.projectPath === null
    ? null
    : (projects.find((project) => project.path === routine.projectPath) ?? null)
}
