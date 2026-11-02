import { useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { UsageScope } from '@shared/usage'
import { cn } from '@renderer/lib/utils'
import type { UsagePage as PageData } from '@renderer/stores/usage'
import { Heatmap, HeatLegend } from './charts'
import {
  addDays,
  busiestWeekday,
  figures,
  heatmapRange,
  metricKind,
  metricValue,
  streaks,
  usedOutside,
  type DayTotal,
  type Metric,
} from './model'
import { Panel, PanelTitle } from './panel'
import { dayText, useMetricText, useRangeText, wholePercent } from './text'

/** A stat's line on its left, beside another stat. */
const LEFT_LINE = 'shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]'
/** Jan 4, 2026 was a Sunday, so the days after it name each weekday. */
const A_SUNDAY = new Date(2026, 0, 4).getTime()

/** The last 53 weeks day by day, then what the chosen range's days add up to. */
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
  const monthLabel = useCallback(
    (day: number) => new Intl.DateTimeFormat(i18n.language, { month: 'short' }).format(day),
    [i18n.language],
  )
  const weekdayLabel = useCallback(
    (day: number) => new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(day),
    [i18n.language],
  )
  const outside = usedOutside(starts, values, page.range)

  const active = useMemo(() => figures(days, page.range), [days, page.range])
  const runs = useMemo(() => streaks(days, page.range, page.today), [days, page.range, page.today])
  const weekday = useMemo(
    () => busiestWeekday(days, page.range, page.firstDay, metric, scope),
    [days, page.range, page.firstDay, metric, scope],
  )
  const none = t('activity.stats.none')
  const stats: { label: string; value: string; tail?: ReactNode }[] = [
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
      tail: runs.longest && rangeText(runs.longest.from, addDays(runs.longest.to, 1)),
    },
    {
      label: t('activity.stats.weekday'),
      value: weekday
        ? new Intl.DateTimeFormat(i18n.language, { weekday: 'long' }).format(
            addDays(A_SUNDAY, weekday.weekday),
          )
        : none,
      tail: weekday && t(`activity.stats.shareOf.${kind}`, { share: wholePercent(weekday.share) }),
    },
  ]

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <PanelTitle className="flex-1">{t('activity.title')}</PanelTitle>
        {outside && <span className="text-caption text-tertiary">{t('activity.outside')}</span>}
        <HeatLegend less={t('activity.less')} more={t('activity.more')} />
      </div>
      <Heatmap
        days={starts}
        values={values}
        range={page.range}
        label={t('activity.label')}
        monthLabel={monthLabel}
        weekdayLabel={weekdayLabel}
        tip={(i) =>
          t('activity.cell', {
            date: dayText(starts[i]!),
            value: values[i]! > 0 ? text.short(values[i]!) : t('figures.none'),
          })
        }
        spoken={(i) => text.sentence(dayText(starts[i]!), values[i]!)}
      />
      <dl className="-mx-4.5 mt-5 grid grid-cols-2 gap-y-4 pt-4 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)] @min-[35rem]:grid-cols-4">
        {stats.map((stat, i) => (
          <div
            key={stat.label}
            className={cn(
              'flex min-w-0 flex-col gap-0.75 px-4.5',
              i % 2 === 1 && LEFT_LINE,
              i === 2 && '@min-[35rem]:shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]',
            )}
          >
            <dt className="text-small text-tertiary">{stat.label}</dt>
            <dd className="text-[15px] font-semibold text-primary tabular-nums">
              {stat.value}
              {stat.tail && (
                <span className="ml-1.5 text-hint font-normal text-tertiary">{stat.tail}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}
