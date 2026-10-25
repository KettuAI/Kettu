// Schedules, in fixed zones through Intl: clock changes, cron, validation and their words.

import { describe, expect, it } from 'vitest'
import enRoutines from './locales/en/routines.json'
import zhRoutines from './locales/zh-CN/routines.json'
import type { Schedule } from './routines'
import {
  MIN_GAP,
  nextRuns,
  occurrencesBetween,
  parseCron,
  scheduleWords,
  validateSchedule,
} from './schedule'

const at = (iso: string): number => Date.parse(iso)

function runs(schedule: Schedule, after: string, timeZone: string, count = 1) {
  return nextRuns(schedule, at(after), { count, timeZone })
}

const cron = (expression: string): Schedule => ({ kind: 'cron', expression })

describe('clock changes', () => {
  it('runs a time in a gap at the gap end, in every zone shape', () => {
    expect(runs(cron('30 2 10 3 *'), '2024-03-01T00:00:00Z', 'America/New_York')).toEqual([
      { at: at('2024-03-10T07:00:00Z'), shift: 'gap' },
    ])
    expect(runs(cron('30 2 31 3 *'), '2024-03-01T00:00:00Z', 'Europe/Berlin')).toEqual([
      { at: at('2024-03-31T01:00:00Z'), shift: 'gap' },
    ])
    expect(runs(cron('15 2 6 10 *'), '2024-09-01T00:00:00Z', 'Australia/Lord_Howe')).toEqual([
      { at: at('2024-10-05T15:30:00Z'), shift: 'gap' },
    ])
    expect(runs(cron('0 0 8 9 *'), '2024-08-01T00:00:00Z', 'America/Santiago')).toEqual([
      { at: at('2024-09-08T04:00:00Z'), shift: 'gap' },
    ])
  })

  it('runs a repeated time once, at its first occurrence', () => {
    expect(runs(cron('30 1 3 11 *'), '2024-10-01T00:00:00Z', 'America/New_York')).toEqual([
      { at: at('2024-11-03T05:30:00Z'), shift: 'overlap' },
    ])
    expect(runs(cron('30 2 27 10 *'), '2024-09-01T00:00:00Z', 'Europe/Berlin')).toEqual([
      { at: at('2024-10-27T00:30:00Z'), shift: 'overlap' },
    ])
    expect(runs(cron('45 1 7 4 *'), '2024-03-01T00:00:00Z', 'Australia/Lord_Howe')).toEqual([
      { at: at('2024-04-06T14:45:00Z'), shift: 'overlap' },
    ])
    expect(runs(cron('30 23 6 4 *'), '2024-04-01T00:00:00Z', 'America/Santiago')).toEqual([
      { at: at('2024-04-07T02:30:00Z'), shift: 'overlap' },
    ])
  })

  it('counts an every schedule in elapsed time across a clock change', () => {
    const schedule: Schedule = {
      kind: 'every',
      minutes: 60,
      from: at('2024-11-03T04:00:00Z'),
    }
    expect(runs(schedule, '2024-11-03T04:30:00Z', 'America/New_York', 2)).toEqual([
      { at: at('2024-11-03T05:00:00Z'), shift: null },
      { at: at('2024-11-03T06:00:00Z'), shift: null },
    ])
  })

  it('resolves a one-time schedule that falls in a gap', () => {
    const schedule: Schedule = { kind: 'once', at: '2024-03-10T02:30' }
    expect(runs(schedule, '2024-03-09T00:00:00Z', 'America/New_York')).toEqual([
      { at: at('2024-03-10T07:00:00Z'), shift: 'gap' },
    ])
  })

  it('starts an every schedule at its instant, not before', () => {
    const from = at('2024-06-01T13:00:00Z')
    const schedule: Schedule = { kind: 'every', minutes: 60, from }
    expect(runs(schedule, '2024-06-01T12:00:00Z', 'UTC', 2)).toEqual([
      { at: from, shift: null },
      { at: from + 60 * 60_000, shift: null },
    ])
    expect(
      occurrencesBetween(schedule, at('2024-06-01T12:00:00Z'), at('2024-06-01T12:30:00Z'), 'UTC'),
    ).toBeNull()
  })
})

describe('cron', () => {
  it('understands macros', () => {
    expect(runs(cron('@daily'), '2024-06-01T12:00:00Z', 'America/New_York')).toEqual([
      { at: at('2024-06-02T04:00:00Z'), shift: null },
    ])
    expect(runs(cron('@weekly'), '2024-06-01T12:00:00Z', 'America/New_York')).toEqual([
      { at: at('2024-06-02T04:00:00Z'), shift: null },
    ])
    expect(runs(cron('@hourly'), '2024-06-01T12:01:00Z', 'UTC')).toEqual([
      { at: at('2024-06-01T13:00:00Z'), shift: null },
    ])
  })

  it('understands names, ranges, lists and steps', () => {
    expect(runs(cron('0 9 * jan mon'), '2025-01-01T00:00:00Z', 'America/New_York')).toEqual([
      { at: at('2025-01-06T14:00:00Z'), shift: null },
    ])
    expect(runs(cron('*/15 * * * *'), '2024-06-01T12:07:00Z', 'UTC')).toEqual([
      { at: at('2024-06-01T12:15:00Z'), shift: null },
    ])
    expect(runs(cron('0 9-17/2 * * *'), '2024-06-01T12:00:00Z', 'UTC')).toEqual([
      { at: at('2024-06-01T13:00:00Z'), shift: null },
    ])
    expect(runs(cron('0 12 * * 7'), '2024-06-01T00:00:00Z', 'UTC')).toEqual([
      { at: at('2024-06-02T12:00:00Z'), shift: null },
    ])
    expect(runs(cron('0 9 1,15 * *'), '2024-04-02T00:00:00Z', 'UTC')).toEqual([
      { at: at('2024-04-15T09:00:00Z'), shift: null },
    ])
  })

  it('matches either day when both day fields are restricted', () => {
    const domOrMonday = runs(cron('0 0 1 * 1'), '2024-03-31T23:59:00Z', 'UTC', 3)
    expect(domOrMonday.map((run) => new Date(run.at).toISOString())).toEqual([
      '2024-04-01T00:00:00.000Z',
      '2024-04-08T00:00:00.000Z',
      '2024-04-15T00:00:00.000Z',
    ])
    const domOrFriday = runs(cron('0 0 1 * 5'), '2024-03-31T23:59:00Z', 'UTC', 5)
    expect(domOrFriday.map((run) => new Date(run.at).toISOString())).toEqual([
      '2024-04-01T00:00:00.000Z',
      '2024-04-05T00:00:00.000Z',
      '2024-04-12T00:00:00.000Z',
      '2024-04-19T00:00:00.000Z',
      '2024-04-26T00:00:00.000Z',
    ])
    const starDay = runs(cron('0 0 1 * *'), '2024-04-01T00:00:00Z', 'UTC', 2)
    expect(starDay.map((run) => new Date(run.at).toISOString())).toEqual([
      '2024-05-01T00:00:00.000Z',
      '2024-06-01T00:00:00.000Z',
    ])
    // A star inside a step still makes the field unrestricted, as cron counts it.
    const oddMonday = runs(cron('0 0 */2 * 1'), '2024-03-31T23:59:00Z', 'UTC', 3)
    expect(oddMonday.map((run) => new Date(run.at).toISOString())).toEqual([
      '2024-04-01T00:00:00.000Z',
      '2024-04-15T00:00:00.000Z',
      '2024-04-29T00:00:00.000Z',
    ])
  })

  it('parses a five-field expression and refuses anything else', () => {
    const parsed = parseCron('0 9 * * 1-5')
    expect('reason' in parsed).toBe(false)
    if ('reason' in parsed) return
    expect(parsed).toMatchObject({
      minutes: [0],
      hours: [9],
      daysOfMonth: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31,
      ],
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      daysOfWeek: [1, 2, 3, 4, 5],
      domStar: true,
      dowStar: false,
    })
    expect(parseCron('0 9 * *')).toMatchObject({ reason: 'format', field: 'expression' })
    expect(parseCron('@sometimes')).toMatchObject({ reason: 'format', field: 'expression' })
    expect(parseCron('61 * * * *')).toMatchObject({
      reason: 'range',
      field: 'minute',
      min: 0,
      max: 59,
    })
    expect(parseCron('0 9 * * 8')).toMatchObject({
      reason: 'range',
      field: 'dayOfWeek',
      min: 0,
      max: 7,
    })
    expect(parseCron('0 9 * * MON-FRI')).toMatchObject({ daysOfWeek: [1, 2, 3, 4, 5] })
  })
})

describe('validation', () => {
  const now = at('2024-06-01T12:00:00Z')

  it('accepts every kind at its limits', () => {
    expect(validateSchedule({ kind: 'once', at: '2024-06-02T09:00' }, now, 'UTC')).toBeNull()
    expect(validateSchedule({ kind: 'every', minutes: 5, from: now }, now, 'UTC')).toBeNull()
    expect(validateSchedule({ kind: 'every', minutes: 720, from: now }, now, 'UTC')).toBeNull()
    expect(
      validateSchedule({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, now, 'UTC'),
    ).toBeNull()
    expect(validateSchedule(cron('*/5 * * * *'), now, 'UTC')).toBeNull()
    expect(validateSchedule(cron('58,0 9 * * *'), now, 'UTC')).toBeNull()
  })

  it('names the field of a problem', () => {
    expect(validateSchedule({ kind: 'once', at: '2024-05-01T09:00' }, now, 'UTC')).toMatchObject({
      reason: 'past',
      field: 'date',
    })
    expect(validateSchedule({ kind: 'once', at: '2024-06-01T11:00' }, now, 'UTC')).toMatchObject({
      reason: 'past',
      field: 'time',
    })
    expect(validateSchedule({ kind: 'every', minutes: 4, from: now }, now, 'UTC')).toMatchObject({
      reason: 'range',
      field: 'every',
      min: 5,
      max: 720,
    })
    expect(validateSchedule({ kind: 'every', minutes: 721, from: now }, now, 'UTC')).toMatchObject({
      reason: 'range',
      field: 'every',
    })
    expect(validateSchedule({ kind: 'weekly', days: [], time: '09:00' }, now, 'UTC')).toMatchObject(
      { reason: 'empty', field: 'days' },
    )
    expect(
      validateSchedule({ kind: 'weekly', days: [1, 7], time: '09:00' }, now, 'UTC'),
    ).toMatchObject({ reason: 'range', field: 'days' })
    expect(validateSchedule({ kind: 'weekly', days: [1], time: '9:00' }, now, 'UTC')).toMatchObject(
      { reason: 'format', field: 'time' },
    )
    expect(validateSchedule(cron('0 0 30 2 *'), now, 'UTC')).toMatchObject({
      reason: 'never',
      field: 'expression',
    })
    expect(validateSchedule(cron('*/4 * * * *'), now, 'UTC')).toMatchObject({
      reason: 'frequent',
      field: 'minute',
    })
    expect(validateSchedule(cron('0,4 * * * *'), now, 'UTC')).toMatchObject({
      reason: 'frequent',
      field: 'minute',
    })
    expect(validateSchedule(cron('58,0 * * * *'), now, 'UTC')).toMatchObject({
      reason: 'frequent',
      field: 'minute',
    })
  })

  it('keeps runs at least five minutes apart', () => {
    expect(MIN_GAP).toBe(5 * 60_000)
    const schedule = cron('0,5 * * * *')
    const found = nextRuns(schedule, now, { count: 200, until: now + 5 * 366 * 24 * 60 * 60_000 })
    for (let index = 1; index < found.length; index++) {
      expect(found[index]!.at - found[index - 1]!.at).toBeGreaterThanOrEqual(MIN_GAP)
    }
  })
})

describe('occurrences between two instants', () => {
  it('counts an every schedule exactly', () => {
    const schedule: Schedule = { kind: 'every', minutes: 5, from: at('2024-06-01T12:00:00Z') }
    expect(
      occurrencesBetween(schedule, at('2024-06-01T12:00:00Z'), at('2024-06-01T12:30:00Z'), 'UTC'),
    ).toEqual({
      first: { at: at('2024-06-01T12:05:00Z'), shift: null },
      last: { at: at('2024-06-01T12:30:00Z'), shift: null },
      count: 6,
    })
  })

  it('counts a weekly schedule over a weekend', () => {
    const schedule: Schedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }
    expect(
      occurrencesBetween(schedule, at('2024-06-07T10:00:00Z'), at('2024-06-10T10:00:00Z'), 'UTC'),
    ).toEqual({
      first: { at: at('2024-06-10T09:00:00Z'), shift: null },
      last: { at: at('2024-06-10T09:00:00Z'), shift: null },
      count: 1,
    })
  })

  it('counts a cron schedule by the minute', () => {
    const span = occurrencesBetween(
      cron('* * * * *'),
      at('2024-06-01T12:00:00Z'),
      at('2024-06-01T12:10:00Z'),
      'UTC',
    )
    expect(span?.count).toBe(10)
    expect(span?.first.at).toBe(at('2024-06-01T12:01:00Z'))
    expect(span?.last.at).toBe(at('2024-06-01T12:10:00Z'))
  })
})

interface Catalog {
  schedule: Record<string, string | Record<string, string> | undefined>
}

function catalog(locale: 'en' | 'zh-CN'): Catalog {
  return (locale === 'en' ? enRoutines : zhRoutines) as Catalog
}

function translate(locale: 'en' | 'zh-CN') {
  const messages = catalog(locale)
  return (key: string, params: Record<string, string | number> = {}): string => {
    const name = key.replace(/^schedule\./, '')
    const plural = `_${Number(params.count) === 1 ? 'one' : 'other'}`
    const template = messages.schedule[name] ?? messages.schedule[`${name}${plural}`]
    if (typeof template !== 'string') throw new Error(`No ${locale} message for ${key}`)
    return template.replace(/\{\{(\w+)\}\}/g, (_, field: string) => String(params[field] ?? ''))
  }
}

describe('words', () => {
  it('reads each kind in English', () => {
    const t = translate('en')
    expect(scheduleWords({ kind: 'once', at: '2024-03-10T02:30' }, t, 'en')).toBe(
      'Mar 10 at 2:30 AM',
    )
    expect(scheduleWords({ kind: 'every', minutes: 120, from: 0 }, t, 'en')).toBe('Every 2 hours')
    expect(scheduleWords({ kind: 'every', minutes: 60, from: 0 }, t, 'en')).toBe('Every hour')
    expect(scheduleWords({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, t, 'en')).toBe(
      'Weekdays at 9:00 AM',
    )
    expect(
      scheduleWords({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, t, 'en'),
    ).toBe('Every day at 9:00 AM')
    expect(scheduleWords({ kind: 'weekly', days: [1, 3, 5], time: '09:00' }, t, 'en')).toBe(
      'Mon, Wed, & Fri at 9:00 AM',
    )
    expect(scheduleWords(cron('0 9 * * 1'), t, 'en')).toBe('Cron 0 9 * * 1')
  })

  it('reads each kind in Chinese', () => {
    const t = translate('zh-CN')
    expect(scheduleWords({ kind: 'once', at: '2024-03-10T02:30' }, t, 'zh-CN')).toBe('3月10日 2:30')
    expect(scheduleWords({ kind: 'every', minutes: 120, from: 0 }, t, 'zh-CN')).toBe('每 2 小时')
    expect(
      scheduleWords({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, t, 'zh-CN'),
    ).toBe('工作日 9:00')
    expect(scheduleWords(cron('0 9 * * 1'), t, 'zh-CN')).toBe('Cron 0 9 * * 1')
  })
})
