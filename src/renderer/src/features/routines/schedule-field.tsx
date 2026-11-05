// A routine's schedule: the kind and its fields, the runs ahead, and what is wrong with it.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CalendarIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ClockIcon,
  InfoIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { enUS, zhCN } from 'react-day-picker/locale'
import { nextRuns, validateSchedule, type ScheduleProblem } from '@shared/schedule'
import type { Schedule } from '@shared/routines'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Calendar } from '@renderer/components/ui/calendar'
import { Input } from '@renderer/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
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
  previewTime,
  scheduleWords,
} from './model'

type Segment = 'once' | 'every' | 'daily' | 'weekly' | 'cron'

const SEGMENTS: Segment[] = ['once', 'every', 'daily', 'weekly', 'cron']

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/** The week as the days row lists it, from Monday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0]

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

function weekdayName(day: number, width: 'short' | 'long'): string {
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

  const preview = problem ? [] : nextRuns(draft, now, { count: draft.kind === 'once' ? 1 : 3 })
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
  const tokens = segment === 'cron' ? cronTokens(expression) : null
  const badField =
    problem && segment === 'cron' ? CRON_FIELDS.findIndex((field) => field === problem.field) : -1

  return (
    <div className="flex w-full flex-col">
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
      {segment !== 'cron' && (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          {segment === 'once' && (
            <Labeled label={t('schedule.date')}>
              <Popover open={picking} onOpenChange={setPicking}>
                <PopoverTrigger
                  render={<Button variant="outline" aria-label={t('schedule.date')} />}
                >
                  <CalendarIcon data-icon="inline-start" className="size-3.5 text-tertiary" />
                  <span className="tabular-nums">{dayDate(localTime(date), now)}</span>
                  <ChevronDownIcon data-icon="inline-end" className="size-3.5 text-tertiary" />
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
            </Labeled>
          )}
          {segment === 'every' && (
            <>
              <Labeled label={t('schedule.everyValue')}>
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
              </Labeled>
              <Labeled label={t('schedule.countedFrom')}>
                <ClockField
                  value={fromText ?? clockOf(from ?? nextHour())}
                  label={t('schedule.countedFrom')}
                  onChange={(text) => {
                    setFromText(text)
                    if (!isClock(text)) return
                    const start = todayAt(text)
                    setFrom(start)
                    update({ kind: 'every', minutes, from: start })
                  }}
                  onBlur={() => setFromText(null)}
                />
              </Labeled>
            </>
          )}
          {segment === 'weekly' && (
            <Labeled label={t('schedule.days')}>
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
                {WEEK.map((day) => (
                  <ToggleGroupItem
                    key={day}
                    value={String(day)}
                    aria-label={weekdayName(day, 'long')}
                    className="h-8 min-w-8.5 px-1.75 text-hint"
                  >
                    {weekdayName(day, 'short')}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Labeled>
          )}
          {(segment === 'once' || segment === 'daily' || segment === 'weekly') && (
            <Labeled label={t('schedule.time')}>
              <ClockField value={time} label={t('schedule.time')} onChange={setClock} />
            </Labeled>
          )}
        </div>
      )}
      {segment === 'cron' && (
        <div className="mt-4">
          <Labeled label={t('schedule.expression')}>
            <Input
              value={expression}
              aria-label={t('schedule.expression')}
              aria-invalid={!!problem || undefined}
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
          </Labeled>
          {tokens && (
            // Each field's text over its name, as the expression gives them.
            <div aria-hidden className="mt-2 grid grid-cols-5 gap-2 px-3">
              {CRON_FIELDS.map((field, index) => (
                <span
                  key={field}
                  className={cn(
                    'flex min-w-0 flex-col text-tertiary',
                    index === caretField && 'text-primary',
                    index === badField && 'text-danger',
                  )}
                >
                  <span className="truncate font-mono text-code-sm">{tokens[index] ?? ' '}</span>
                  <span className="truncate text-meta">{t(`schedule.field.${field}`)}</span>
                </span>
              ))}
            </div>
          )}
          {!problem && (
            <p className="mt-2 px-3 text-hint text-tertiary">{t('schedule.cronSyntax')}</p>
          )}
        </div>
      )}

      {problem && !ran ? (
        <>
          <p className="mt-2.5 flex gap-1.5 text-hint text-danger">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {problemText(problem, translate)}
          </p>
          <Alert variant="warning" className="mt-3 bg-warning-tint">
            <TriangleAlertIcon />
            <AlertDescription className="text-primary">
              {saved
                ? t('schedule.unvalid', { schedule: scheduleWords(saved) })
                : t('routine.scheduleNotSaved')}
            </AlertDescription>
          </Alert>
        </>
      ) : (
        <div className="mt-4 rounded-code bg-subtle px-3.5 py-3">
          <div className="flex gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-lede leading-5 font-medium">{scheduleWords(draft)}</p>
              <p className="mt-px text-hint text-tertiary">
                {ran && onceAt !== null
                  ? t('schedule.ranOnce', { date: dayDate(onceAt, now), time: clockTime(onceAt) })
                  : draft.kind === 'once'
                    ? t('schedule.onceOff')
                    : t('schedule.nextRuns')}
              </p>
            </div>
            {!ran && (
              <ul className="flex shrink-0 flex-col gap-0.75 text-right text-hint text-secondary tabular">
                {preview.map((run) => (
                  <li key={`${run.at}-${run.shift ?? ''}`}>{previewTime(run.at, now)}</li>
                ))}
              </ul>
            )}
          </div>
          {!ran &&
            preview.map((run) =>
              run.shift ? (
                <p key={`shift-${run.at}`} className="mt-2.5 flex gap-2 text-hint text-warning">
                  <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {run.shift === 'gap'
                    ? t('schedule.clockGap', { time: clockTime(run.at) })
                    : t('schedule.clockOverlap')}
                </p>
              ) : null,
            )}
        </div>
      )}
    </div>
  )
}

/** A field's label over it. */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span aria-hidden className="mb-1.5 text-small leading-4 font-medium text-tertiary">
        {label}
      </span>
      {children}
    </div>
  )
}

/** A time of day, typed, with a clock before it. */
function ClockField({
  value,
  label,
  onChange,
  onBlur,
}: {
  value: string
  label: string
  onChange: (value: string) => void
  onBlur?: () => void
}) {
  return (
    <InputGroup className="w-28.5">
      <InputGroupAddon>
        <ClockIcon className="text-tertiary" />
      </InputGroupAddon>
      <InputGroupInput
        type="time"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="tabular [&::-webkit-calendar-picker-indicator]:hidden"
      />
    </InputGroup>
  )
}

/** A cron expression's fields as typed; none for a macro such as @daily. */
function cronTokens(expression: string): string[] | null {
  const text = expression.trim()
  if (text.startsWith('@')) return null
  return text === '' ? [] : text.split(/\s+/)
}
