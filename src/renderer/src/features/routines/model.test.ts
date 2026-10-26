import { afterEach, describe, expect, it } from 'vitest'
import type { RoutineRun, RoutineView } from '@shared/routines'
import { i18n } from '@renderer/lib/i18n'
import {
  cronFieldAt,
  dayTime,
  everyChoices,
  minutesLabel,
  onRoutines,
  routineState,
  rowDay,
  runDay,
  runDuration,
  runTrigger,
  runsHint,
  sinceTime,
  stateText,
  untilTime,
} from './model'

// Local times, as the pages show them. 2026-10-26 is a Monday.
const at = (day: number, hour: number, minute = 0, month = 9, year = 2026): number =>
  new Date(year, month, day, hour, minute).getTime()
const NOW = at(26, 15, 13)
const MINUTE = 60_000

afterEach(() => i18n.changeLanguage('en'))

function run(changes: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 'run-1',
    routineId: 'r-000000000001',
    trigger: 'schedule',
    scheduledFor: null,
    count: 1,
    status: 'succeeded',
    reason: null,
    sessionId: null,
    startedAt: null,
    endedAt: null,
    workingMs: 0,
    stopReason: null,
    error: null,
    output: null,
    usage: null,
    changedFiles: [],
    seen: true,
    ...changes,
  }
}

function routine(changes: Partial<RoutineView> = {}): RoutineView {
  return {
    id: 'r-000000000001',
    name: 'Morning briefing',
    prompt: 'Summarize what changed since yesterday.',
    agentId: 'codex',
    projectPath: null,
    options: [],
    trigger: {
      kind: 'schedule',
      schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
    },
    scope: { level: 'read', web: false },
    timeLimitMinutes: 60,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    checkedThrough: 0,
    state: 'on',
    nextRunAt: null,
    pause: null,
    activeRun: null,
    lastRun: null,
    unseen: { failed: 0, ended: 0 },
    sessions: 0,
    ...changes,
  }
}

describe('times on the routines pages', () => {
  it('says how far ahead a time is, to the minute, rounded up', () => {
    expect(untilTime(NOW + 30_000, NOW)).toBe('in 1 min')
    expect(untilTime(NOW + 47 * MINUTE, NOW)).toBe('in 47 min')
    expect(untilTime(NOW + 120 * MINUTE, NOW)).toBe('in 2 h')
    expect(untilTime(NOW + (17 * 60 + 47) * MINUTE, NOW)).toBe('in 17 h 47 min')
    expect(untilTime(NOW + 24 * 60 * MINUTE, NOW)).toBe('in 1 day')
    expect(untilTime(at(28, 9), NOW)).toBe('in 2 days')
  })

  it("names a run's day: today, tomorrow, yesterday, else its weekday and date", () => {
    expect(runDay(at(26, 9), NOW)).toBe('Today, 9:00 AM')
    expect(runDay(at(27, 9), NOW)).toBe('Tomorrow, 9:00 AM')
    expect(runDay(at(25, 22, 58), NOW)).toBe('Yesterday, 10:58 PM')
    expect(runDay(at(28, 9), NOW)).toBe('Wed, Oct 28, 9:00 AM')
    expect(runDay(at(23, 9), NOW)).toBe('Fri, Oct 23, 9:00 AM')
    expect(runDay(at(4, 9, 0, 0, 2027), NOW)).toBe('Mon, Jan 4, 2027, 9:00 AM')
  })

  it("puts how soon under a row's time today, else its day", () => {
    expect(rowDay(at(26, 16), NOW)).toBe('Today · in 47 min')
    expect(rowDay(at(27, 9), NOW)).toBe('Tomorrow')
    expect(rowDay(at(30, 9), NOW)).toBe('Fri, Oct 30')
  })

  it('says when something began: the time today, else its day too', () => {
    expect(sinceTime(at(26, 9), NOW)).toBe('9:00 AM')
    expect(sinceTime(at(25, 22, 58), NOW)).toBe('Yesterday, 10:58 PM')
  })

  it('keeps the day and time other places use', () => {
    expect(dayTime(at(26, 9), NOW)).toBe('Today, 9:00 AM')
    expect(dayTime(at(27, 9), NOW)).toBe('Tomorrow, 9:00 AM')
    expect(dayTime(at(29, 9), NOW)).toBe('Thu, 9:00 AM')
    expect(dayTime(at(5, 9, 0, 10), NOW)).toBe('Nov 5, 9:00 AM')
  })

  it('writes them in Chinese with the language', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(untilTime(NOW + (17 * 60 + 47) * MINUTE, NOW)).toBe('17 小时 47 分钟后')
    expect(runDay(at(25, 22, 58), NOW)).toBe('昨天 22:58')
    expect(rowDay(at(26, 16), NOW)).toBe('今天 · 47 分钟后')
  })
})

describe('a routine on its row and page', () => {
  it('leads with a run waiting for approval, since its working time stopped', () => {
    const waiting = routine({
      nextRunAt: at(27, 9),
      activeRun: run({ status: 'waiting', startedAt: at(26, 9), workingMs: 2 * MINUTE }),
    })
    expect(routineState(waiting)).toEqual({ kind: 'waiting', since: at(26, 9, 2) })
    expect(stateText(waiting, NOW)).toBe('Waiting for your approval since 9:02 AM')
    expect(routineState(routine({ activeRun: run({ status: 'waiting' }) }))).toEqual({
      kind: 'waiting',
      since: null,
    })
  })

  it('says since when a run works, and that one starts', () => {
    const running = routine({ activeRun: run({ status: 'running', startedAt: at(26, 15, 10) }) })
    expect(stateText(running, NOW)).toBe('Running since 3:10 PM')
    const starting = routine({ activeRun: run({ status: 'starting', startedAt: at(26, 15, 13) }) })
    expect(stateText(starting, NOW)).toBe('Starting')
  })

  it('names the next run today, tomorrow or later, with how soon', () => {
    expect(stateText(routine({ nextRunAt: at(26, 16) }), NOW)).toBe(
      'Next run today, 4:00 PM · in 47 min',
    )
    expect(stateText(routine({ nextRunAt: at(27, 9) }), NOW)).toBe(
      'Next run tomorrow, 9:00 AM · in 17 h 47 min',
    )
    expect(stateText(routine({ nextRunAt: at(28, 9) }), NOW)).toBe(
      'Next run Wed, Oct 28, 9:00 AM · in 2 days',
    )
  })

  it('says off and done', () => {
    expect(stateText(routine({ enabled: false, state: 'off' }), NOW)).toBe('Off')
    expect(stateText(routine({ state: 'done' }), NOW)).toBe('Done')
  })

  it('orders On by what needs the user, then what works, then the next run, then the name', () => {
    const list = [
      routine({ id: 'r-later', name: 'B', nextRunAt: at(28, 9) }),
      routine({ id: 'r-soon-b', name: 'B', nextRunAt: at(26, 16) }),
      routine({ id: 'r-soon-a', name: 'A', nextRunAt: at(26, 16) }),
      routine({ id: 'r-off', enabled: false, state: 'off' }),
      routine({ id: 'r-done', state: 'done' }),
      routine({ id: 'r-running', nextRunAt: at(30, 9), activeRun: run({ status: 'running' }) }),
      routine({ id: 'r-waiting', nextRunAt: at(30, 9), activeRun: run({ status: 'waiting' }) }),
    ]
    expect(onRoutines(list).map((shown) => shown.id)).toEqual([
      'r-waiting',
      'r-running',
      'r-soon-a',
      'r-soon-b',
      'r-later',
    ])
  })

  it('says what Run now does under an empty history, and when the first run comes', () => {
    expect(runsHint(routine(), NOW)).toBe('Run now tries it.')
    expect(runsHint(routine({ nextRunAt: at(26, 16) }), NOW)).toBe(
      'Run now tries it, or wait for today, 4:00 PM.',
    )
    expect(runsHint(routine({ nextRunAt: at(27, 9) }), NOW)).toBe(
      'Run now tries it, or wait for tomorrow, 9:00 AM.',
    )
    expect(runsHint(routine({ nextRunAt: at(28, 9) }), NOW)).toBe(
      'Run now tries it, or wait for Wed, Oct 28, 9:00 AM.',
    )
  })
})

describe('a run in the history', () => {
  it('names every trigger, a scheduled run included', () => {
    expect(runTrigger(run({ trigger: 'manual' }))).toBe('Run now')
    expect(runTrigger(run({ trigger: 'catch-up' }))).toBe('Catch-up')
    expect(runTrigger(run({ trigger: 'schedule' }))).toBe('Scheduled')
  })

  it('counts a wait that goes on as waiting', () => {
    const waiting = run({
      status: 'waiting',
      startedAt: NOW - (6 * 60 + 15) * MINUTE,
      workingMs: 2 * MINUTE,
    })
    expect(runDuration(waiting, NOW)).toBe('Waiting 6 h 13 m')
  })
})

describe('schedule choices', () => {
  it("offers the usual lengths, with a routine's own among them", () => {
    expect(everyChoices(60)).toEqual([5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720])
    expect(everyChoices(90)).toEqual([5, 10, 15, 30, 60, 90, 120, 180, 240, 360, 480, 720])
  })

  it('names a length in hours when it is whole hours', () => {
    expect(minutesLabel(15)).toBe('15 minutes')
    expect(minutesLabel(60)).toBe('1 hour')
    expect(minutesLabel(120)).toBe('2 hours')
    expect(minutesLabel(90)).toBe('90 minutes')
  })

  it('finds the cron field the caret is in', () => {
    expect(cronFieldAt('0 9 * * 1-5', 0)).toBe(0)
    expect(cronFieldAt('0 9 * * 1-5', 3)).toBe(1)
    expect(cronFieldAt('0 9 * * 1-5', 4)).toBe(2)
    expect(cronFieldAt('0 9 * * 1-5', 11)).toBe(4)
    expect(cronFieldAt('  0 9', 1)).toBe(0)
    expect(cronFieldAt('0 9 * * 1 2', 11)).toBeNull()
    expect(cronFieldAt('@daily', 3)).toBeNull()
  })
})
