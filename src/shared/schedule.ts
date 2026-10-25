// Schedules: when a routine runs, in local time, and the words the interface uses for them.

import type { Locale } from './locale'
import type { Schedule } from './routines'

export const MINUTE = 60_000
export const DAY = 24 * 60 * MINUTE
/** The closest two runs of one schedule may be. */
export const MIN_GAP = 5 * MINUTE
/** How far ahead a recurring schedule is looked at, at most. */
export const HORIZON = 5 * 366 * DAY
export const EVERY_MIN = 5
export const EVERY_MAX = 720

/** The part of a schedule a problem belongs to, for the field name beside it. */
export type ScheduleField =
  | 'date'
  | 'time'
  | 'every'
  | 'days'
  | 'expression'
  | 'minute'
  | 'hour'
  | 'dayOfMonth'
  | 'month'
  | 'dayOfWeek'

export type ScheduleProblem =
  | { reason: 'format'; field: ScheduleField; detail: string }
  | { reason: 'range'; field: ScheduleField; detail: string; min: number; max: number }
  | { reason: 'past'; field: ScheduleField }
  | { reason: 'never'; field: ScheduleField }
  | { reason: 'frequent'; field: ScheduleField }
  | { reason: 'empty'; field: ScheduleField }

/** A time a schedule runs, and the clock change that moved or repeated it, if any. */
export interface ScheduledRun {
  at: number
  shift: 'gap' | 'overlap' | null
}

export interface NextRunsOptions {
  count?: number
  /** No run after this instant. */
  until?: number
  /** An IANA zone; the computer's own by default. */
  timeZone?: string
}

export interface Occurrences {
  first: ScheduledRun
  last: ScheduledRun
  /** How many scheduled times the span holds. */
  count: number
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface Civil {
  year: number
  month: number
  day: number
}

interface CivilTime extends Civil {
  hour: number
  minute: number
}

const ONCE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const CLOCK = /^(\d{2}):(\d{2})$/

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function onceCivil(at: string): CivilTime | null {
  const match = ONCE.exec(at)
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  if (hour > 23 || minute > 59) return null
  return { year, month, day, hour, minute }
}

function clockCivil(time: string): { hour: number; minute: number } | null {
  const match = CLOCK.exec(time)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour > 23 || minute > 59 ? null : { hour, minute }
}

function dayNumberOf(civil: Civil): number {
  return Math.floor(Date.UTC(civil.year, civil.month - 1, civil.day) / DAY)
}

function civilOfDay(day: number): Civil {
  const date = new Date(day * DAY)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

/** 0 is Sunday, as a weekly schedule counts. */
function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7
}

interface LocalTime extends CivilTime {
  second: number
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    zoneFormatters.set(timeZone, formatter)
  }
  return formatter
}

function localTimeOf(timeZone: string, at: number): LocalTime {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(at))
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour') % 24,
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** The wall clock at an instant, as a UTC timestamp of the same fields. */
function wallOf(timeZone: string, at: number): number {
  const local = localTimeOf(timeZone, at)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
}

function offsetAt(timeZone: string, at: number): number {
  return wallOf(timeZone, at) - Math.floor(at / 1000) * 1000
}

/**
 * A local time as an instant. A time in a gap runs once at the gap's end; a repeated time runs
 * once, at its first occurrence.
 */
function resolveCivil(timeZone: string, civil: CivilTime): ScheduledRun {
  const nominal = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute)
  const offsets = new Set<number>()
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    offsets.add(offsetAt(timeZone, nominal + hours * 60 * MINUTE))
  }
  const instants = new Set<number>()
  for (const offset of offsets) {
    const at = nominal - offset
    if (wallOf(timeZone, at) === nominal) instants.add(at)
  }
  if (instants.size > 0) {
    return { at: Math.min(...instants), shift: instants.size > 1 ? 'overlap' : null }
  }
  const candidates = [...offsets].map((offset) => nominal - offset).sort((a, b) => a - b)
  let low = candidates[0]!
  let high = candidates[candidates.length - 1]!
  if (wallOf(timeZone, low) >= nominal) low = nominal - 48 * 60 * MINUTE
  for (let i = 0; i < 40 && high - low > 1; i++) {
    const mid = Math.floor((low + high) / 2)
    if (wallOf(timeZone, mid) >= nominal) high = mid
    else low = mid
  }
  return { at: high, shift: 'gap' }
}

interface Cron {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  /** Whether the field was written with a star, which decides the either-day rule. */
  domStar: boolean
  dowStar: boolean
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

interface FieldSpec {
  field: ScheduleField
  min: number
  max: number
  names: Record<string, number> | null
}

const CRON_FIELDS: readonly FieldSpec[] = [
  { field: 'minute', min: 0, max: 59, names: null },
  { field: 'hour', min: 0, max: 23, names: null },
  { field: 'dayOfMonth', min: 1, max: 31, names: null },
  { field: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { field: 'dayOfWeek', min: 0, max: 7, names: DAY_NAMES },
]

type ParsedValue = { value: number } | Extract<ScheduleProblem, { reason: 'format' | 'range' }>

function fieldValue(raw: string, spec: FieldSpec): ParsedValue {
  const named = spec.names?.[raw.toLowerCase()]
  if (named !== undefined) return { value: named }
  if (!/^\d+$/.test(raw)) {
    return {
      reason: 'format',
      field: spec.field,
      detail: `"${raw}" is not a number, name, range or step`,
    }
  }
  const value = Number(raw)
  if (value < spec.min || value > spec.max) {
    return { reason: 'range', field: spec.field, detail: `"${raw}"`, min: spec.min, max: spec.max }
  }
  return { value }
}

function rangeValues(from: number, to: number, step: number): number[] {
  const values: number[] = []
  for (let value = from; value <= to; value += step) values.push(value)
  return values
}

function parseTerm(
  term: string,
  spec: FieldSpec,
): { values: number[] } | Extract<ScheduleProblem, { reason: 'format' | 'range' }> {
  const parts = term.split('/')
  if (parts.length > 2) {
    return {
      reason: 'format',
      field: spec.field,
      detail: `"${term}" is not a number, name, range or step`,
    }
  }
  const body = parts[0]!
  let step = 1
  if (parts[1] !== undefined) {
    if (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1) {
      return {
        reason: 'format',
        field: spec.field,
        detail: `"${term}" is not a number, name, range or step`,
      }
    }
    step = Number(parts[1])
  }
  if (body === '*') return { values: rangeValues(spec.min, spec.max, step) }
  const range = body.split('-')
  if (range.length > 2) {
    return {
      reason: 'format',
      field: spec.field,
      detail: `"${term}" is not a number, name, range or step`,
    }
  }
  if (range.length === 2) {
    const from = fieldValue(range[0]!, spec)
    if ('reason' in from) return from
    const to = fieldValue(range[1]!, spec)
    if ('reason' in to) return to
    if (from.value > to.value) {
      return { reason: 'format', field: spec.field, detail: `"${term}" ends before it starts` }
    }
    return { values: rangeValues(from.value, to.value, step) }
  }
  const value = fieldValue(body, spec)
  if ('reason' in value) return value
  return parts[1] !== undefined
    ? { values: rangeValues(value.value, spec.max, step) }
    : { values: [value.value] }
}

function parseField(text: string, spec: FieldSpec): { values: number[] } | ScheduleProblem {
  const values = new Set<number>()
  for (const term of text.split(',')) {
    if (term === '') {
      return { reason: 'format', field: spec.field, detail: `"${text}" has an empty item` }
    }
    const parsed = parseTerm(term, spec)
    if ('reason' in parsed) return parsed
    for (const value of parsed.values) values.add(value)
  }
  return {
    values: [...values]
      .map((value) => (spec.field === 'dayOfWeek' && value === 7 ? 0 : value))
      .sort((a, b) => a - b),
  }
}

export function parseCron(expression: string): Cron | ScheduleProblem {
  const trimmed = expression.trim()
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed
  if (expanded.startsWith('@')) {
    return { reason: 'format', field: 'expression', detail: `"${trimmed}" is not a cron macro` }
  }
  const fields = expanded.split(/\s+/).filter((field) => field !== '')
  if (fields.length !== 5) {
    return { reason: 'format', field: 'expression', detail: 'use five fields' }
  }
  const parsed: number[][] = []
  for (const [index, spec] of CRON_FIELDS.entries()) {
    const field = parseField(fields[index]!, spec)
    if ('reason' in field) return field
    parsed.push(field.values)
  }
  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
    domStar: fields[2]!.includes('*'),
    dowStar: fields[4]!.includes('*'),
  }
}

function dayMatches(cron: Cron, civil: Civil, day: number): boolean {
  if (!cron.months.includes(civil.month)) return false
  const dom = cron.daysOfMonth.includes(civil.day)
  const dow = cron.daysOfWeek.includes(weekdayOf(day))
  // With both day fields restricted, either one matches.
  return cron.domStar || cron.dowStar ? dom && dow : dom || dow
}

function candidateRuns(cron: Cron, civil: Civil, timeZone: string): ScheduledRun[] {
  const runs: ScheduledRun[] = []
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      runs.push(resolveCivil(timeZone, { ...civil, hour, minute }))
    }
  }
  return runs
}

function nextOnce(at: string, after: number, until: number, timeZone: string): ScheduledRun[] {
  const civil = onceCivil(at)
  if (!civil) return []
  const run = resolveCivil(timeZone, civil)
  return run.at > after && run.at <= until ? [run] : []
}

function nextEvery(
  schedule: Extract<Schedule, { kind: 'every' }>,
  after: number,
  count: number,
  until: number,
): ScheduledRun[] {
  const step = schedule.minutes * MINUTE
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(schedule.from)) return []
  let index = Math.max(0, Math.floor((after - schedule.from) / step) + 1)
  const runs: ScheduledRun[] = []
  while (runs.length < count) {
    const at = schedule.from + index * step
    if (at <= after) {
      index += 1
      continue
    }
    if (at > until) break
    runs.push({ at, shift: null })
    index += 1
  }
  return runs
}

function nextWeekly(
  schedule: Extract<Schedule, { kind: 'weekly' }>,
  after: number,
  count: number,
  until: number,
  timeZone: string,
): ScheduledRun[] {
  const time = clockCivil(schedule.time)
  if (!time || schedule.days.length === 0) return []
  const days = new Set(schedule.days)
  const start = dayNumberOf(localTimeOf(timeZone, after))
  const end = dayNumberOf(localTimeOf(timeZone, Math.min(until, after + HORIZON)))
  const runs: ScheduledRun[] = []
  for (let day = start; day <= end && runs.length < count; day++) {
    if (!days.has(weekdayOf(day))) continue
    const run = resolveCivil(timeZone, { ...civilOfDay(day), ...time })
    if (run.at <= after || run.at > until) continue
    runs.push(run)
  }
  return runs
}

function nextCron(
  expression: string,
  after: number,
  count: number,
  until: number,
  timeZone: string,
): ScheduledRun[] {
  const cron = parseCron(expression)
  if ('reason' in cron) return []
  const start = dayNumberOf(localTimeOf(timeZone, after))
  const end = dayNumberOf(localTimeOf(timeZone, Math.min(until, after + HORIZON)))
  const afterWall = wallOf(timeZone, after)
  const runs: ScheduledRun[] = []
  for (let day = start; day <= end && runs.length < count; day++) {
    const civil = civilOfDay(day)
    if (!dayMatches(cron, civil, day)) continue
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const nominal = Date.UTC(civil.year, civil.month - 1, civil.day, hour, minute)
        // A clock change moves a time by at most a couple of hours; anything earlier is past.
        if (nominal < afterWall - 3 * 60 * MINUTE) continue
        const run = resolveCivil(timeZone, { ...civil, hour, minute })
        if (run.at <= after) continue
        if (run.at > until) return runs
        runs.push(run)
        if (runs.length >= count) return runs
      }
    }
  }
  return runs
}

/** The runs of a schedule after `after`, in order, at most `count` and no later than `until`. */
export function nextRuns(
  schedule: Schedule,
  after: number,
  options: NextRunsOptions = {},
): ScheduledRun[] {
  const count = options.count ?? 1
  const until = options.until ?? Number.POSITIVE_INFINITY
  const timeZone = options.timeZone ?? systemTimeZone()
  if (count <= 0 || !Number.isFinite(after) || until <= after) return []
  switch (schedule.kind) {
    case 'once':
      return nextOnce(schedule.at, after, until, timeZone)
    case 'every':
      return nextEvery(schedule, after, count, until)
    case 'weekly':
      return nextWeekly(schedule, after, count, until, timeZone)
    case 'cron':
      return nextCron(schedule.expression, after, count, until, timeZone)
  }
}

function weeklyOccurrences(
  schedule: Extract<Schedule, { kind: 'weekly' }>,
  after: number,
  until: number,
  timeZone: string,
): Occurrences | null {
  const time = clockCivil(schedule.time)
  if (!time || schedule.days.length === 0) return null
  const days = new Set(schedule.days)
  const floor = Math.max(after, until - HORIZON)
  const start = dayNumberOf(localTimeOf(timeZone, floor))
  const end = dayNumberOf(localTimeOf(timeZone, until))
  let first: ScheduledRun | null = null
  let last: ScheduledRun | null = null
  let count = 0
  for (let day = start; day <= end; day++) {
    if (!days.has(weekdayOf(day))) continue
    const run = resolveCivil(timeZone, { ...civilOfDay(day), ...time })
    if (run.at <= floor || run.at > until) continue
    first ??= run
    last = run
    count += 1
  }
  return first && last ? { first, last, count } : null
}

function cronOccurrences(
  expression: string,
  after: number,
  until: number,
  timeZone: string,
): Occurrences | null {
  const cron = parseCron(expression)
  if ('reason' in cron) return null
  const floor = Math.max(after, until - HORIZON)
  const start = dayNumberOf(localTimeOf(timeZone, floor))
  const end = dayNumberOf(localTimeOf(timeZone, until))
  const perDay = cron.hours.length * cron.minutes.length
  let count = 0
  let first: ScheduledRun | null = null
  let last: ScheduledRun | null = null
  for (let day = start; day <= end; day++) {
    const civil = civilOfDay(day)
    if (!dayMatches(cron, civil, day)) continue
    if (day === start || day === end) {
      for (const run of candidateRuns(cron, civil, timeZone)) {
        if (run.at <= floor || run.at > until) continue
        first ??= run
        last = run
        count += 1
      }
    } else {
      count += perDay
    }
  }
  if (!first || !last) return null
  return { first, last, count }
}

/** The runs between two instants, as the first, the last and how many in all. */
export function occurrencesBetween(
  schedule: Schedule,
  after: number,
  until: number,
  timeZone = systemTimeZone(),
): Occurrences | null {
  if (!(until > after)) return null
  const floor = Math.max(after, until - HORIZON)
  switch (schedule.kind) {
    case 'once': {
      const civil = onceCivil(schedule.at)
      if (!civil) return null
      const run = resolveCivil(timeZone, civil)
      return run.at > after && run.at <= until ? { first: run, last: run, count: 1 } : null
    }
    case 'every': {
      const step = schedule.minutes * MINUTE
      if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(schedule.from)) return null
      let firstIndex = Math.max(0, Math.floor((floor - schedule.from) / step) + 1)
      let firstAt = schedule.from + firstIndex * step
      while (firstAt <= floor) {
        firstIndex += 1
        firstAt += step
      }
      if (firstAt > until) return null
      let lastIndex = Math.floor((until - schedule.from) / step)
      if (lastIndex < firstIndex) return null
      let lastAt = schedule.from + lastIndex * step
      while (lastAt > until) {
        lastIndex -= 1
        lastAt -= step
      }
      if (lastIndex < firstIndex) return null
      return {
        first: { at: firstAt, shift: null },
        last: { at: lastAt, shift: null },
        count: lastIndex - firstIndex + 1,
      }
    }
    case 'weekly':
      return weeklyOccurrences(schedule, after, until, timeZone)
    case 'cron':
      return cronOccurrences(schedule.expression, after, until, timeZone)
  }
}

function frequentField(cron: Cron): ScheduleField {
  const minutes = cron.minutes
  const close = minutes.some((minute, index) => index > 0 && minute - minutes[index - 1]! < 5)
  const hours = cron.hours
  const consecutive =
    hours.some((hour, index) => index > 0 && hour - hours[index - 1]! === 1) ||
    (hours.length > 1 && hours[0] === 0 && hours[hours.length - 1] === 23)
  const across = 60 - minutes[minutes.length - 1]! + minutes[0]!
  return close || (consecutive && across < 5) ? 'minute' : 'expression'
}

/** What is wrong with a schedule, or null when it can be saved and run. */
export function validateSchedule(
  schedule: Schedule,
  now = Date.now(),
  timeZone = systemTimeZone(),
): ScheduleProblem | null {
  switch (schedule.kind) {
    case 'once': {
      const civil = onceCivil(schedule.at)
      if (!civil) {
        const hasDate = /^\d{4}-\d{2}-\d{2}T/.test(schedule.at)
        return hasDate
          ? { reason: 'format', field: 'time', detail: 'use HH:mm' }
          : { reason: 'format', field: 'date', detail: 'choose a date' }
      }
      const run = resolveCivil(timeZone, civil)
      if (run.at > now) return null
      const today = localTimeOf(timeZone, now)
      const sameDay =
        today.year === civil.year && today.month === civil.month && today.day === civil.day
      return { reason: 'past', field: sameDay ? 'time' : 'date' }
    }
    case 'every': {
      const minutes = schedule.minutes
      if (!Number.isInteger(minutes)) {
        return { reason: 'format', field: 'every', detail: 'whole minutes' }
      }
      if (minutes < EVERY_MIN || minutes > EVERY_MAX) {
        return {
          reason: 'range',
          field: 'every',
          detail: `${minutes}`,
          min: EVERY_MIN,
          max: EVERY_MAX,
        }
      }
      if (!Number.isFinite(schedule.from) || schedule.from < 0) {
        return { reason: 'format', field: 'every', detail: 'a start time' }
      }
      const runs = nextRuns(schedule, now, { count: 1, until: now + HORIZON, timeZone })
      return runs.length === 0 ? { reason: 'never', field: 'every' } : null
    }
    case 'weekly': {
      const days = schedule.days
      if (days.length === 0) return { reason: 'empty', field: 'days' }
      if (new Set(days).size !== days.length) {
        return { reason: 'format', field: 'days', detail: 'each day once' }
      }
      const bad = days.find((day) => !Number.isInteger(day) || day < 0 || day > 6)
      if (bad !== undefined) {
        return { reason: 'range', field: 'days', detail: `${bad}`, min: 0, max: 6 }
      }
      if (!clockCivil(schedule.time)) {
        return { reason: 'format', field: 'time', detail: 'use HH:mm' }
      }
      return null
    }
    case 'cron': {
      const cron = parseCron(schedule.expression)
      if ('reason' in cron) return cron
      const runs = nextRuns(schedule, now, { count: 200, until: now + HORIZON, timeZone })
      if (runs.length === 0) return { reason: 'never', field: 'expression' }
      for (let index = 1; index < runs.length; index++) {
        if (runs[index]!.at - runs[index - 1]!.at < MIN_GAP) {
          return { reason: 'frequent', field: frequentField(cron) }
        }
      }
      return null
    }
  }
}

const SUNDAY = new Date(2024, 0, 7).getTime()

interface WordFormats {
  weekday: Intl.DateTimeFormat
  monthDay: Intl.DateTimeFormat
  clock: Intl.DateTimeFormat
  list: Intl.ListFormat
}

const wordFormats = new Map<string, WordFormats>()

function words(locale: string): WordFormats {
  let made = wordFormats.get(locale)
  if (!made) {
    made = {
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
      monthDay: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
      clock: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
      list: new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }),
    }
    wordFormats.set(locale, made)
  }
  return made
}

function clockWords(locale: string, hour: number, minute: number): string {
  return words(locale).clock.format(new Date(2000, 0, 1, hour, minute))
}

/** A schedule in words, translated by `t` from the routines catalog. */
export function scheduleWords(
  schedule: Schedule,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale = 'en',
): string {
  switch (schedule.kind) {
    case 'once': {
      const civil = onceCivil(schedule.at)
      if (!civil) return t('schedule.once', { date: schedule.at, time: '' })
      const date = new Date(civil.year, civil.month - 1, civil.day)
      return t('schedule.once', {
        date: words(locale).monthDay.format(date),
        time: clockWords(locale, civil.hour, civil.minute),
      })
    }
    case 'every':
      return schedule.minutes % 60 === 0
        ? t('schedule.everyHours', { count: schedule.minutes / 60 })
        : t('schedule.everyMinutes', { count: schedule.minutes })
    case 'weekly': {
      const days = [...schedule.days].sort((a, b) => a - b)
      const time = clockCivil(schedule.time)
      const clock = time ? clockWords(locale, time.hour, time.minute) : schedule.time
      if (days.length === 7) return t('schedule.daily', { time: clock })
      if (days.join() === '1,2,3,4,5') return t('schedule.weekdays', { time: clock })
      const names = days.map((day) => words(locale).weekday.format(SUNDAY + day * DAY))
      return t('schedule.weekly', { days: words(locale).list.format(names), time: clock })
    }
    case 'cron':
      return t('schedule.cron', { expression: schedule.expression.trim() })
  }
}
