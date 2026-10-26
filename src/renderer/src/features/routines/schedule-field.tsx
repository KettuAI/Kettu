// A routine's schedule: the kind and its fields, the runs ahead, and what is wrong with it.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CalendarIcon, ChevronDownIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { enUS, zhCN } from 'react-day-picker/locale'
import { nextRuns, validateSchedule, type ScheduleProblem } from '@shared/schedule'
import type { Schedule } from '@shared/routines'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import { Calendar } from '@renderer/components/ui/calendar'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { FieldSelect } from './fields'
import {
  CRON_FIELDS,
  clockTime,
  cronFieldAt,
  dayDate,
  everyChoices,
  minutesLabel,
  runDay,
  scheduleWords,
  untilTime,
} from './model'

type Segment = 'once' | 'every' | 'daily' | 'weekly' | 'cron'

const SEGMENTS: Segment[] = ['once', 'every', 'daily', 'weekly', 'cron']

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

function segmentOf(schedule: Schedule): Segment {
  if (schedule.kind === 'weekly') return schedule.days.length === 7 ? 'daily' : 'weekly'
  return schedule.kind
}

const pad = (value: number): string => String(value).padStart(2, '0')

function dateOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clockOf(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A local 'YYYY-MM-DD', and 'HH:mm' when given, as an instant. */
function localTime(date: string, time = '00:00'): number {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return new Date(year!, month! - 1, day, hour, minute).getTime()
}

function timeOf(schedule: Schedule): string {
  if (schedule.kind === 'once') return schedule.at.slice(11, 16)
  if (schedule.kind === 'weekly') return schedule.time
  return '09:00'
}

const isClock = (text: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(text)

/** The next whole hour, which a new Every schedule is counted from. */
function nextHour(): number {
  const date = new Date()
  date.setMinutes(60, 0, 0)
  return date.getTime()
}

/** Today at a local 'HH:mm', which an Every schedule is counted from. */
function todayAt(time: string): number {
  return localTime(dateOf(Date.now()), time)
}

function weekdayName(day: number, width: 'narrow' | 'long'): string {
  const sunday = new Date(2024, 0, 7 + day)
  return new Intl.DateTimeFormat(currentLocale(), { weekday: width }).format(sunday)
}

function sameSchedule(a: Schedule, b: Schedule | null): boolean {
  return b !== null && JSON.stringify(a) === JSON.stringify(b)
}

function problemText(
  problem: ScheduleProblem,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const field = t(`schedule.field.${problem.field}`)
  switch (problem.reason) {
    case 'format':
      return t('schedule.problem.format', { field, detail: problem.detail })
    case 'range':
      return t('schedule.problem.range', {
        field,
        detail: problem.detail,
        min: problem.min,
        max: problem.max,
      })
    case 'past':
      return t('schedule.problem.past', { field })
    case 'never':
      return t('schedule.problem.never', { field })
    case 'frequent':
      return t('schedule.problem.frequent', { field })
    case 'empty':
      return t('schedule.problem.empty', { field })
  }
}

/** A field of the schedule with its label before it. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="w-11 shrink-0 text-small text-secondary">{label}</span>
      {children}
    </div>
  )
}

/**
 * The schedule of a routine, edited in place. A valid change is saved at once; an invalid one is
 * kept here, said to be unsaved, and `saved` still runs.
 */
export function ScheduleField({
  schedule,
  saved,
  done = false,
  onSchedule,
  onProblem,
}: {
  schedule: Schedule
  /** The last saved schedule, for the note under an invalid change; null on a new routine. */
  saved: Schedule | null
  /** A one-time routine that has run: its past time says when it ran, not what is wrong. */
  done?: boolean
  onSchedule: (schedule: Schedule) => void
  onProblem?: (problem: ScheduleProblem | null) => void
}) {
  const { t } = useTranslation('routines')
  const now = useNow()
  const [draft, setDraft] = useState<Schedule>(schedule)
  const [minutes, setMinutes] = useState(() => (schedule.kind === 'every' ? schedule.minutes : 60))
  const [from, setFrom] = useState<number | null>(() =>
    schedule.kind === 'every' ? schedule.from : null,
  )
  // What the counted-from field shows while a time is being typed into it.
  const [fromText, setFromText] = useState<string | null>(null)
  const [date, setDate] = useState(() =>
    schedule.kind === 'once' ? schedule.at.slice(0, 10) : dateOf(Date.now()),
  )
  const [time, setTime] = useState(() => timeOf(schedule))
  const [days, setDays] = useState<number[]>(() =>
    schedule.kind === 'weekly' && schedule.days.length < 7
      ? [...schedule.days].sort((a, b) => a - b)
      : [1, 2, 3, 4, 5],
  )
  const [expression, setExpression] = useState(() =>
    schedule.kind === 'cron' ? schedule.expression : '0 9 * * 1-5',
  )
  const [caretField, setCaretField] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)
  const report = useRef(onProblem)
  const problem = validateSchedule(draft, now)
  const ran = done && draft.kind === 'once' && sameSchedule(draft, saved)

  useEffect(() => {
    report.current = onProblem
  }, [onProblem])

  useEffect(() => {
    report.current?.(validateSchedule(draft))
  }, [draft])

  const update = (next: Schedule) => {
    setDraft(next)
    if (!validateSchedule(next, Date.now())) onSchedule(next)
  }

  const choose = (segment: Segment) => {
    if (segment === 'once') {
      update({ kind: 'once', at: `${date}T${time}` })
      return
    }
    if (segment === 'every') {
      const start = from ?? nextHour()
      setFrom(start)
      update({ kind: 'every', minutes, from: start })
      return
    }
    if (segment === 'daily') {
      update({ kind: 'weekly', days: EVERY_DAY, time })
      return
    }
    if (segment === 'weekly') {
      update({ kind: 'weekly', days, time })
      return
    }
    update({ kind: 'cron', expression })
  }

  const setClock = (next: string) => {
    setTime(next)
    if (segmentOf(draft) === 'once') update({ kind: 'once', at: `${date}T${next}` })
    else
      update({ kind: 'weekly', days: segmentOf(draft) === 'daily' ? EVERY_DAY : days, time: next })
  }

  const trackCaret = (input: HTMLInputElement) => {
    setCaretField(cronFieldAt(input.value, input.selectionStart ?? input.value.length))
  }

  const preview = problem ? [] : nextRuns(draft, now, { count: 3 })
  const showWords =
    ran ||
    !problem ||
    problem.reason === 'range' ||
    problem.reason === 'past' ||
    problem.reason === 'never' ||
    problem.reason === 'frequent'
  const segment = segmentOf(draft)
  const translate = t as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string
  const today = localTime(dateOf(now))
  const onceAt =
    draft.kind === 'once' && isClock(draft.at.slice(11, 16))
      ? localTime(draft.at.slice(0, 10), draft.at.slice(11, 16))
      : null

  return (
    <div className="flex w-full flex-col gap-3">
      <SegmentedControl
        aria-label={t('routine.schedule')}
        value={segment}
        segments={SEGMENTS.map((value) => ({
          value,
          label: t(`schedule.kind.${value}`),
        }))}
        onChange={choose}
        className="self-start"
      />
      {segment === 'once' && (
        <Row label={t('schedule.on')}>
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger render={<Button variant="outline" aria-label={t('schedule.date')} />}>
              <CalendarIcon data-icon="inline-start" className="size-3.5 text-icon" />
              <span className="tabular-nums">{dayDate(localTime(date), now)}</span>
              <ChevronDownIcon data-icon="inline-end" className="size-3.5 text-icon" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <Calendar
                mode="single"
                required
                selected={new Date(localTime(date))}
                defaultMonth={new Date(localTime(date))}
                disabled={{ before: new Date(today) }}
                locale={currentLocale() === 'zh-CN' ? zhCN : enUS}
                onSelect={(day: Date) => {
                  const next = dateOf(day.getTime())
                  setDate(next)
                  setPicking(false)
                  update({ kind: 'once', at: `${next}T${time}` })
                }}
              />
            </PopoverContent>
          </Popover>
        </Row>
      )}
      {segment === 'every' && (
        <Row label={t('schedule.everyValue')}>
          <FieldSelect
            label={t('schedule.everyValue')}
            value={String(minutes)}
            options={everyChoices(minutes).map((choice) => ({
              value: String(choice),
              label: minutesLabel(choice),
            }))}
            onChange={(value) => {
              const next = Number(value)
              const start = from ?? nextHour()
              setMinutes(next)
              setFrom(start)
              update({ kind: 'every', minutes: next, from: start })
            }}
          />
          <span className="text-small text-secondary">{t('schedule.countedFrom')}</span>
          <Input
            type="time"
            value={fromText ?? clockOf(from ?? nextHour())}
            aria-label={t('schedule.countedFrom')}
            onChange={(event) => {
              const text = event.target.value
              setFromText(text)
              if (!isClock(text)) return
              const start = todayAt(text)
              setFrom(start)
              update({ kind: 'every', minutes, from: start })
            }}
            onBlur={() => setFromText(null)}
            className="w-30"
          />
        </Row>
      )}
      {segment === 'weekly' && (
        <Row label={t('schedule.days')}>
          <ToggleGroup
            aria-label={t('schedule.days')}
            multiple
            value={days.map(String)}
            onValueChange={(next) => {
              // At least one day stays on, so the schedule always runs.
              if (next.length === 0) return
              const picked = next.map(Number).sort((a, b) => a - b)
              setDays(picked)
              update({ kind: 'weekly', days: picked, time })
            }}
            variant="fill"
            spacing={1}
          >
            {EVERY_DAY.map((day) => (
              <ToggleGroupItem
                key={day}
                value={String(day)}
                aria-label={weekdayName(day, 'long')}
                className="w-8 px-0 text-small"
              >
                {weekdayName(day, 'narrow')}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
      )}
      {(segment === 'once' || segment === 'daily' || segment === 'weekly') && (
        <Row label={t('schedule.time')}>
          <Input
            type="time"
            value={time}
            aria-label={t('schedule.time')}
            onChange={(event) => setClock(event.target.value)}
            className="w-30"
          />
        </Row>
      )}
      {segment === 'cron' && (
        <div className="flex flex-col gap-1.5">
          <Input
            value={expression}
            aria-label={t('schedule.expression')}
            placeholder={t('schedule.expressionHint')}
            spellCheck={false}
            onChange={(event) => {
              setExpression(event.target.value)
              trackCaret(event.target)
              update({ kind: 'cron', expression: event.target.value })
            }}
            onSelect={(event) => trackCaret(event.currentTarget)}
            onFocus={(event) => trackCaret(event.currentTarget)}
            onBlur={() => setCaretField(null)}
            className="font-mono text-command md:text-command"
          />
          <div aria-hidden className="flex flex-wrap gap-x-3.5 px-0.5 text-xs text-tertiary">
            {CRON_FIELDS.map((field, index) => (
              <span key={field} className={cn(index === caretField && 'font-medium text-primary')}>
                {t(`schedule.cronFields.${field}`)}
              </span>
            ))}
          </div>
          <p className="px-0.5 text-xs text-tertiary">{t('schedule.cronSyntax')}</p>
        </div>
      )}

      <div className="rounded-code bg-subtle px-3.5 py-3">
        {showWords && <p className="mb-1.5 text-ui font-medium">{scheduleWords(draft)}</p>}
        {ran && onceAt !== null ? (
          <p className="text-small text-secondary">
            {t('schedule.ranOnce', { date: dayDate(onceAt, now), time: clockTime(onceAt) })}
          </p>
        ) : problem ? (
          <p className="flex gap-1.5 text-small text-danger">
            <CircleAlertIcon aria-hidden className="mt-1 size-3 shrink-0" />
            {problemText(problem, translate)}
          </p>
        ) : (
          <ul className="flex flex-col">
            {preview.map((run) => (
              <li key={`${run.at}-${run.shift ?? ''}`} className="flex flex-col">
                <span className="flex min-h-6.5 items-center gap-3 text-small text-secondary">
                  <span className="min-w-0 flex-1 truncate">{runDay(run.at, now)}</span>
                  <span className="shrink-0 text-xs text-tertiary tabular">
                    {untilTime(run.at, now)}
                  </span>
                </span>
                {run.shift === 'gap' && (
                  <span className="text-xs text-tertiary">
                    {t('schedule.clockGap', { time: clockTime(run.at) })}
                  </span>
                )}
                {run.shift === 'overlap' && (
                  <span className="text-xs text-tertiary">{t('schedule.clockOverlap')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {problem && !ran && saved && (
        <p className="text-xs leading-normal text-tertiary">
          {t('schedule.unvalid', { schedule: scheduleWords(saved) })}
        </p>
      )}
      {problem && !saved && (
        <p className="text-xs leading-normal text-tertiary">{t('routine.scheduleNotSaved')}</p>
      )}
    </div>
  )
}
