import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { UsageScope } from '@shared/usage'
import { monthDay } from '@renderer/lib/format'
import type { UsagePage as PageData } from '@renderer/stores/usage'
import { ChartTip, TipRow } from './chart'
import {
  addDays,
  busiestWeekday,
  figures,
  heatLevels,
  heatmapRange,
  metricKind,
  metricValue,
  streaks,
  type DayTotal,
  type Metric,
  type RangeChoice,
} from './model'
import { dayText, useMetricText, useRangeText, wholePercent } from './text'

/** Jan 4, 2026 was a Sunday, so the days after it name each weekday. */
const A_SUNDAY = new Date(2026, 0, 4).getTime()
/** The weekdays the rows are named by: Monday, Wednesday and Friday. */
const NAMED_DAYS = [1, 3, 5]
/** A month's name needs this many week columns clear before the next one. */
const MONTH_COLUMNS = 3

/**
 * The last 53 weeks day by day, the days outside the range in gray steps of the same shades, then
 * what those weeks add up to, whatever the range.
 */
export function Activity({
  days,
  page,
  metric,
  scope,
  className,
}: {
  /** The page's days for the agents the filter keeps. */
  days: DayTotal[]
  page: PageData
  metric: Metric
  scope: UsageScope
  className?: string
}) {
  const { t, i18n } = useTranslation('usage')
  const kind = metricKind(metric, scope)
  const text = useMetricText(kind)
  const rangeText = useRangeText()
  const heat = heatmapRange(page.today, page.firstDay)
  const heatDays = useMemo(
    () => days.filter((d) => d.day >= heat.from && d.day < heat.to),
    [days, heat.from, heat.to],
  )
  const starts = useMemo(() => heatDays.map((d) => d.day), [heatDays])
  const values = useMemo(
    () => heatDays.map((d) => metricValue(d.parts, metric, scope) ?? 0),
    [heatDays, metric, scope],
  )
  const inRange = useCallback(
    (day: number) => day >= page.range.from && day < page.range.to,
    [page.range],
  )
  const grayed = starts.some((day, i) => values[i]! > 0 && !inRange(day))
  // The card is the last year's, whatever the range above.
  const year = useMemo(() => ({ from: heat.from, to: heat.to }), [heat.from, heat.to])
  const active = useMemo(() => figures(days, year, metric, scope), [days, year, metric, scope])
  const runs = useMemo(() => streaks(days, year, page.today), [days, year, page.today])
  const weekday = useMemo(
    () => busiestWeekday(days, year, page.firstDay, metric, scope),
    [days, year, page.firstDay, metric, scope],
  )
  const weekdayName = (day: number, style: 'long' | 'short') =>
    new Intl.DateTimeFormat(i18n.language, { weekday: style }).format(addDays(A_SUNDAY, day))
  const none = t('activity.stats.none')
  const stats = [
    {
      label: t('activity.stats.active'),
      value: String(active.activeDays),
      tail: t('activity.stats.activeOf', { count: active.days }),
    },
    {
      label: t('activity.stats.average'),
      value: active.average === null ? none : text.short(active.average),
      tail: active.average === null ? null : t('activity.stats.onActive'),
    },
    {
      label: t('activity.stats.current'),
      value: runs.current > 0 ? t('activity.stats.days', { count: runs.current }) : none,
    },
    {
      label: t('activity.stats.longest'),
      value: runs.longest ? t('activity.stats.days', { count: runs.longest.days }) : none,
      tail: runs.longest
        ? runs.longest.days === 1
          ? monthDay(runs.longest.from)
          : rangeText(runs.longest.from, addDays(runs.longest.to, 1))
        : null,
    },
    {
      label: t('activity.stats.weekday'),
      value: weekday ? weekdayName(weekday.weekday, 'long') : none,
      tail: weekday && wholePercent(weekday.share),
    },
  ]
  const rangeName =
    page.filters.range.kind === 'custom'
      ? rangeText(page.range.from, page.range.to)
      : t(
          `activity.ranges.${(page.filters.range as Exclude<RangeChoice, { kind: 'custom' }>).kind}`,
        )

  return (
    <section className={`k-u-card k-u-act ${className ?? ''}`} aria-labelledby="activity-title">
      <header className="k-u-card__head">
        <h3 id="activity-title">{t('activity.title')}</h3>
        <span className="k-u-meta">
          {grayed ? t('activity.spanGray', { range: rangeName }) : t('activity.span')}
        </span>
        <span aria-hidden className="k-u-act__legend">
          {t('activity.less')}
          {[0, 1, 2, 3, 4].map((v) => (
            <i key={v} data-v={v} />
          ))}
          {t('activity.more')}
        </span>
      </header>
      <div className="k-u-act__body">
        <Heatmap
          days={starts}
          values={values}
          today={page.today}
          firstDay={page.firstDay}
          inRange={inRange}
          weekday={(day) => weekdayName(day, 'short')}
          label={t('activity.label')}
          tip={(i) => (values[i]! > 0 ? text.short(values[i]!) : t('figures.none'))}
          spoken={(i) => text.sentence(dayText(starts[i]!), values[i]!)}
        />
      </div>
      <dl className="k-u-act__stats">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt>{stat.label}</dt>
            <dd className="k-num">
              {stat.value}
              {stat.tail && <small>{stat.tail}</small>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Where the arrow keys, Home and End take a day: left and right a week, up and down a day. */
function moveDay(key: string, index: number, count: number): number | null {
  const steps: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
  const next =
    key === 'Home' ? 0 : key === 'End' ? count - 1 : key in steps ? index + steps[key]! : null
  if (next === null) return null
  return Math.min(count - 1, Math.max(0, next))
}

/**
 * A week to a column, the first day of the week on top, the months named above and three
 * weekdays beside; today is outlined and the days after it are left empty. A day is read on
 * hover, or with the arrow keys once the grid has focus.
 */
function Heatmap({
  days,
  values,
  today,
  firstDay,
  inRange,
  weekday,
  label,
  tip,
  spoken,
}: {
  /** The heatmap's day starts, oldest first, starting on the first day of a week. */
  days: readonly number[]
  values: readonly number[]
  today: number
  firstDay: number
  inRange: (day: number) => boolean
  weekday: (day: number) => string
  label: string
  tip: (index: number) => string
  spoken: (index: number) => string
}) {
  const { i18n } = useTranslation('usage')
  const grid = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [at, setAt] = useState<DOMRect | null>(null)
  const levels = useMemo(() => heatLevels(values), [values])
  const busiest = useMemo(
    () =>
      values.reduce((best, value, i) => (value > (values[best] ?? 0) ? i : best), days.length - 1),
    [values, days.length],
  )
  const future = (7 - (days.length % 7)) % 7
  const columns = Math.ceil(days.length / 7)
  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n.language, { month: 'short' })
    const out: { column: number; text: string }[] = []
    for (let column = 0; column < columns; column++) {
      const first = days[column * 7]
      if (first === undefined) continue
      const date = new Date(first)
      if (date.getDate() > 7) continue
      const last = out[out.length - 1]
      if (last && column - last.column < MONTH_COLUMNS) continue
      out.push({ column, text: format.format(first) })
    }
    // The first column's month gives way to the next one's when they would crowd.
    if (out.length > 1 && out[1]!.column - out[0]!.column < MONTH_COLUMNS) out.shift()
    return out
  }, [days, columns, i18n.language])

  const choose = (index: number | null) => {
    setChosen(index)
    const cell =
      index === null ? null : grid.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)
    setAt(cell ? cell.getBoundingClientRect() : null)
  }
  const pick = (event: PointerEvent) => {
    const index = (event.target as HTMLElement).dataset.i
    if (index !== undefined && Number(index) !== chosen) choose(Number(index))
  }

  return (
    <div className="k-u-heat" style={{ '--weeks': columns } as CSSProperties}>
      <span aria-hidden className="k-u-heat__months">
        {months.map((month) => (
          <span key={month.column} style={{ gridColumnStart: month.column + 1 }}>
            {month.text}
          </span>
        ))}
      </span>
      <span aria-hidden className="k-u-heat__days">
        {Array.from({ length: 7 }, (_, row) => {
          const day = (firstDay + row) % 7
          return <span key={row}>{NAMED_DAYS.includes(day) ? weekday(day) : ''}</span>
        })}
      </span>
      <div
        ref={grid}
        role="group"
        tabIndex={0}
        aria-label={label}
        className="k-u-act__grid"
        onPointerOver={pick}
        onPointerLeave={() => choose(null)}
        onFocus={(event) => {
          if (event.target.matches(':focus-visible') && days.length > 0) choose(busiest)
        }}
        onBlur={() => choose(null)}
        onKeyDown={(event) => {
          const next = moveDay(event.key, chosen ?? busiest, days.length)
          if (next === null) return
          event.preventDefault()
          choose(next)
        }}
      >
        {levels.map((level, i) => (
          <i
            key={i}
            data-i={i}
            data-v={level}
            data-out={(level > 0 && !inRange(days[i]!)) || undefined}
            data-today={days[i] === today || undefined}
            data-on={chosen === i || undefined}
          />
        ))}
        {Array.from({ length: future }, (_, i) => (
          <i key={`f${i}`} data-later />
        ))}
      </div>
      <ChartTip at={at}>
        {chosen !== null && <TipRow label={dayText(days[chosen]!)} value={tip(chosen)} />}
      </ChartTip>
      <span role="status" className="sr-only">
        {chosen !== null ? spoken(chosen) : ''}
      </span>
    </div>
  )
}
