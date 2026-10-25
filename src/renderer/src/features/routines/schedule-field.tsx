// A routine's schedule: the kind and its fields, the runs ahead, and what is wrong with it.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { nextRuns, validateSchedule, type ScheduleProblem } from '@shared/schedule'
import type { Schedule } from '@shared/routines'
import { Input } from '@renderer/components/ui/input'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { SettingSelect } from '@renderer/features/settings/controls'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { clockTime, dayTime, scheduleWords, untilTime } from './model'

type Segment = 'once' | 'every' | 'daily' | 'weekly' | 'cron'

const SEGMENTS: Segment[] = ['once', 'every', 'daily', 'weekly', 'cron']

function segmentOf(schedule: Schedule): Segment {
  if (schedule.kind === 'weekly') return schedule.days.length === 7 ? 'daily' : 'weekly'
  return schedule.kind
}

const pad = (value: number): string => String(value).padStart(2, '0')

function dateOf(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timeOf(schedule: Schedule): string {
  if (schedule.kind === 'once') return schedule.at.slice(11, 16)
  if (schedule.kind === 'weekly') return schedule.time
  return '09:00'
}

interface EveryParts {
  value: string
  unit: 'minutes' | 'hours'
}

function everyParts(minutes: number): EveryParts {
  return minutes >= 60 && minutes % 60 === 0
    ? { value: String(minutes / 60), unit: 'hours' }
    : { value: String(minutes), unit: 'minutes' }
}

function everyMinutes(value: string, unit: EveryParts['unit']): number {
  const number = Number(value)
  return unit === 'hours' ? number * 60 : number
}

function weekdayName(day: number, width: 'narrow' | 'long'): string {
  const monday = new Date(2024, 0, 7 + day)
  return new Intl.DateTimeFormat(currentLocale(), { weekday: width }).format(monday)
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
  onSchedule,
  onProblem,
}: {
  schedule: Schedule
  /** The last saved schedule, for the note under an invalid change; null on a new routine. */
  saved: Schedule | null
  onSchedule: (schedule: Schedule) => void
  onProblem?: (problem: ScheduleProblem | null) => void
}) {
  const { t } = useTranslation('routines')
  const now = useNow()
  const [draft, setDraft] = useState<Schedule>(schedule)
  const [every, setEveryState] = useState<EveryParts>(() =>
    everyParts(schedule.kind === 'every' ? schedule.minutes : 60),
  )
  const [date, setDate] = useState(() =>
    schedule.kind === 'once' ? schedule.at.slice(0, 10) : dateOf(Date.now()),
  )
  const [time, setTime] = useState(() => timeOf(schedule))
  const [days, setDays] = useState<number[]>(() =>
    schedule.kind === 'weekly' ? [...schedule.days].sort((a, b) => a - b) : [1, 2, 3, 4, 5],
  )
  const [expression, setExpression] = useState(() =>
    schedule.kind === 'cron' ? schedule.expression : '0 9 * * 1-5',
  )
  const report = useRef(onProblem)
  const problem = validateSchedule(draft, now)

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
      update({
        kind: 'every',
        minutes: everyMinutes(every.value, every.unit),
        from: Date.now(),
      })
      return
    }
    if (segment === 'daily') {
      update({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time })
      return
    }
    if (segment === 'weekly') {
      update({ kind: 'weekly', days, time })
      return
    }
    update({ kind: 'cron', expression })
  }

  const setEvery = (value: string, unit: EveryParts['unit']) => {
    setEveryState({ value, unit })
    update({ kind: 'every', minutes: everyMinutes(value, unit), from: Date.now() })
  }

  const setClock = (next: string) => {
    setTime(next)
    update(
      segmentOf(draft) === 'daily'
        ? { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: next }
        : { kind: 'weekly', days, time: next },
    )
  }

  const preview = problem ? [] : nextRuns(draft, now, { count: 3 })
  const showWords =
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label={t('routine.schedule')}
          value={segment}
          segments={SEGMENTS.map((value) => ({
            value,
            label: t(`schedule.kind.${value}`),
          }))}
          onChange={choose}
        />
        {segment === 'once' && (
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={date}
              aria-label={t('schedule.date')}
              onChange={(event) => {
                setDate(event.target.value)
                update({ kind: 'once', at: `${event.target.value}T${time}` })
              }}
              className="w-40"
            />
            <Input
              type="time"
              value={time}
              aria-label={t('schedule.time')}
              onChange={(event) => {
                setTime(event.target.value)
                update({ kind: 'once', at: `${date}T${event.target.value}` })
              }}
              className="w-32"
            />
          </div>
        )}
        {segment === 'every' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-tertiary">{t('schedule.everyValue')}</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={every.value}
              aria-label={t('schedule.everyValue')}
              onChange={(event) => setEvery(event.target.value, every.unit)}
              className="w-20"
            />
            <SettingSelect
              label={t('schedule.unit')}
              value={every.unit}
              options={[
                { value: 'minutes', label: t('schedule.minutesUnit') },
                { value: 'hours', label: t('schedule.hoursUnit') },
              ]}
              onChange={(unit) => {
                const minutes = everyMinutes(every.value, every.unit)
                const value =
                  unit === 'hours' ? String(Math.max(1, Math.round(minutes / 60))) : String(minutes)
                setEvery(value, unit)
              }}
            />
          </div>
        )}
        {(segment === 'daily' || segment === 'weekly') && (
          <div className="flex items-center gap-3">
            {segment === 'weekly' && (
              <ToggleGroup
                aria-label={t('schedule.days')}
                multiple
                value={days.map(String)}
                onValueChange={(next) => {
                  const picked = next.map(Number).sort((a, b) => a - b)
                  setDays(picked)
                  update({ kind: 'weekly', days: picked, time })
                }}
                variant="segmented"
                size="compact"
                spacing={0.5}
              >
                {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                  <ToggleGroupItem
                    key={day}
                    value={String(day)}
                    aria-label={weekdayName(day, 'long')}
                    className="w-8 justify-center px-0"
                  >
                    {weekdayName(day, 'narrow')}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            <Input
              type="time"
              value={time}
              aria-label={t('schedule.time')}
              onChange={(event) => setClock(event.target.value)}
              className="w-32"
            />
          </div>
        )}
        {segment === 'cron' && (
          <Input
            value={expression}
            aria-label={t('schedule.expression')}
            placeholder={t('schedule.expressionHint')}
            onChange={(event) => {
              setExpression(event.target.value)
              update({ kind: 'cron', expression: event.target.value })
            }}
            className="max-w-64"
          />
        )}
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg bg-card px-3 py-2.5">
        {showWords && <p className="text-ui font-medium">{scheduleWords(draft)}</p>}
        {problem ? (
          <p className="text-xs leading-normal text-danger">{problemText(problem, translate)}</p>
        ) : (
          <>
            <p className="text-xs font-medium text-tertiary">{t('schedule.nextRuns')}</p>
            <ul className="flex flex-col gap-0.5 text-xs leading-normal text-secondary">
              {preview.map((run) => (
                <li key={`${run.at}-${run.shift ?? ''}`} className="flex flex-col">
                  <span>
                    {t('schedule.runAt', {
                      when: dayTime(run.at, now),
                      away: untilTime(run.at, now),
                    })}
                  </span>
                  {run.shift === 'gap' && (
                    <span className="text-tertiary">
                      {t('schedule.clockGap', { time: clockTime(run.at) })}
                    </span>
                  )}
                  {run.shift === 'overlap' && (
                    <span className="text-tertiary">{t('schedule.clockOverlap')}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {problem && saved && (
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
