import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { UsageScope } from '@shared/usage'
import type { UsagePage as PageData } from '@renderer/stores/usage'
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
} from './model'
import { dayText, useMetricText, useRangeText, wholePercent } from './text'

/** Jan 4, 2026 was a Sunday, so the days after it name each weekday. */
const A_SUNDAY = new Date(2026, 0, 4).getTime()

/** The last 53 weeks day by day, then what they add up to. */
export function Activity({
  days,
  page,
  metric,
  scope,
}: {
  /** The page's days for the agents the filter keeps. */
  days: DayTotal[]
  page: PageData
  metric: Metric
  scope: UsageScope
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
  // The card is the last year's, whatever the range above.
  const year = useMemo(() => ({ from: heat.from, to: heat.to }), [heat.from, heat.to])
  const active = useMemo(() => figures(days, year), [days, year])
  const runs = useMemo(() => streaks(days, year, page.today), [days, year, page.today])
  const weekday = useMemo(
    () => busiestWeekday(days, year, page.firstDay, metric, scope),
    [days, year, page.firstDay, metric, scope],
  )
  const none = t('activity.stats.none')
  const stats: { label: string; value: string; tail?: ReactNode; title?: string }[] = [
    {
      label: t('activity.stats.active'),
      value: String(active.activeDays),
      tail: t('activity.stats.activeOf', { count: active.days }),
    },
    {
      label: t('activity.stats.current'),
      value: runs.current > 0 ? t('activity.stats.days', { count: runs.current }) : none,
    },
    {
      label: t('activity.stats.longest'),
      value: runs.longest ? t('activity.stats.days', { count: runs.longest.days }) : none,
      title: runs.longest ? rangeText(runs.longest.from, addDays(runs.longest.to, 1)) : undefined,
    },
    {
      label: t('activity.stats.weekday'),
      value: weekday
        ? new Intl.DateTimeFormat(i18n.language, { weekday: 'long' }).format(
            addDays(A_SUNDAY, weekday.weekday),
          )
        : none,
      tail: weekday && wholePercent(weekday.share),
    },
  ]

  return (
    <div className="k-u-card k-u-act">
      <span className="k-u-act__head">
        <span className="k-u-cap">{t('activity.title')}</span>
        <span className="k-u-act__legend">
          {t('activity.less')}
          {[0, 1, 2, 3, 4].map((v) => (
            <i key={v} data-v={v} />
          ))}
          {t('activity.more')}
        </span>
      </span>
      <div className="k-u-act__body">
        <Heatmap
          days={starts}
          values={values}
          label={t('activity.label')}
          tip={(i) =>
            t('activity.cell', {
              date: dayText(starts[i]!),
              value: values[i]! > 0 ? text.short(values[i]!) : t('figures.none'),
            })
          }
          spoken={(i) => text.sentence(dayText(starts[i]!), values[i]!)}
        />
        <dl className="k-u-act__stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd className="k-num" title={stat.title}>
                {stat.value}
                {stat.tail && <small> {stat.tail}</small>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
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
 * A week to a column, the first day of the week on top; the days after today are outlined. A
 * day is read on hover, or with the arrow keys once the grid has focus.
 */
function Heatmap({
  days,
  values,
  label,
  tip,
  spoken,
}: {
  /** The heatmap's day starts, oldest first, starting on the first day of a week. */
  days: readonly number[]
  values: readonly number[]
  label: string
  tip: (index: number) => string
  spoken: (index: number) => string
}) {
  const grid = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; size: number; column: number } | null>(
    null,
  )
  const levels = useMemo(() => heatLevels(values), [values])
  const busiest = useMemo(
    () =>
      values.reduce((best, value, i) => (value > (values[best] ?? 0) ? i : best), days.length - 1),
    [values, days.length],
  )
  const future = (7 - (days.length % 7)) % 7
  const columns = Math.ceil(days.length / 7)

  useLayoutEffect(() => {
    const cell =
      chosen === null ? null : grid.current?.querySelector<HTMLElement>(`[data-i="${chosen}"]`)
    setBox(
      chosen !== null && cell
        ? {
            x: cell.offsetLeft,
            y: cell.offsetTop,
            size: cell.offsetWidth,
            column: Math.floor(chosen / 7),
          }
        : null,
    )
  }, [chosen, days])

  const pick = useCallback((event: PointerEvent) => {
    const index = (event.target as HTMLElement).dataset.i
    if (index !== undefined) setChosen(Number(index))
  }, [])
  // The tooltip starts at its day near the left edge, ends at it near the right, else centres.
  const align = !box ? 0 : box.column < 4 ? 0 : box.column >= columns - 4 ? 1 : 0.5

  return (
    <>
      <div
        ref={grid}
        role="group"
        tabIndex={0}
        aria-label={label}
        className="k-u-act__grid"
        style={{ '--weeks': columns } as CSSProperties}
        onPointerOver={pick}
        onPointerLeave={() => setChosen(null)}
        onFocus={(event) => {
          if (event.target.matches(':focus-visible') && days.length > 0) setChosen(busiest)
        }}
        onBlur={() => setChosen(null)}
        onKeyDown={(event) => {
          const next = moveDay(event.key, chosen ?? busiest, days.length)
          if (next === null) return
          event.preventDefault()
          setChosen(next)
        }}
      >
        {levels.map((level, i) => (
          <i key={i} data-i={i} data-v={level} />
        ))}
        {Array.from({ length: future }, (_, i) => (
          <i key={`f${i}`} data-out />
        ))}
        {box && chosen !== null && (
          <>
            <span
              aria-hidden
              className="k-u-act__ring"
              style={{
                width: box.size,
                height: box.size,
                transform: `translate(${box.x}px, ${box.y}px)`,
              }}
            />
            <span
              aria-hidden
              className="k-u-act__tip"
              style={{
                left: box.x + box.size * align,
                top: box.y,
                transform: `translate(${-align * 100}%, calc(-100% - 6px))`,
              }}
            >
              {tip(chosen)}
            </span>
          </>
        )}
      </div>
      <span role="status" className="sr-only">
        {chosen !== null ? spoken(chosen) : ''}
      </span>
    </>
  )
}
