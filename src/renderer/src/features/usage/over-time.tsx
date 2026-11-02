import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sortAgentIds, type AgentId } from '@shared/thread'
import type { UsageScope } from '@shared/usage'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useClock } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { setUsageFilters, useUsageStore, type UsagePage as PageData } from '@renderer/stores/usage'
import { TrendAxis, TrendChart, TrendLegend } from './charts'
import {
  busiest,
  hourBars,
  hourLabels,
  legendHidden,
  legendHides,
  metricKind,
  namesYear,
  NO_SERIES,
  seriesOf,
  shownSeries,
  shownTotals,
  trend,
  wholeMonth,
  type DayTotal,
  type LegendChoice,
  type Metric,
  type MetricKind,
  type TrendBar,
} from './model'
import { Panel, PanelTitle, SEGMENT } from './panel'
import { dayText, useHourText, useMetricText, useRangeText } from './text'

/** A one-day range's totals per hour, and the hour starts they were summed over. */
export interface HourTotals {
  totals: DayTotal[]
  starts: number[]
  /** The clocks change that day, so its hours name their time zones. */
  zoned: boolean
}

/** What the chart counts and by what unit, for screen readers. */
const TREND_TITLE = {
  tokens: {
    hour: 'trend.hourly',
    day: 'trend.daily',
    week: 'trend.weekly',
    month: 'trend.monthly',
  },
  requests: {
    hour: 'trend.requestsHourly',
    day: 'trend.requestsDaily',
    week: 'trend.requestsWeekly',
    month: 'trend.requestsMonthly',
  },
  turns: {
    hour: 'trend.turnsHourly',
    day: 'trend.turnsDaily',
    week: 'trend.turnsWeekly',
    month: 'trend.turnsMonthly',
  },
  cost: {
    hour: 'trend.costHourly',
    day: 'trend.costDaily',
    week: 'trend.costWeekly',
    month: 'trend.costMonthly',
  },
} as const satisfies Record<MetricKind, Record<'hour' | 'day' | 'week' | 'month', string>>
/** Hours are labelled every 1, 2, 3, 4, 6 or 12, so the labels fall on the same times each day. */
const HOUR_STEPS = [1, 2, 3, 4, 6, 12]
/** A placeholder waits this long, so a quick answer shows no flash. */
const PLACEHOLDER_DELAY = 200

/** Whether `waiting` has held for longer than `PLACEHOLDER_DELAY`. */
function useLate(waiting: boolean): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setLate(true), PLACEHOLDER_DELAY)
    return () => {
      clearTimeout(timer)
      setLate(false)
    }
  }, [waiting])
  return waiting && late
}

/** The range in bars, with the metric's control and the agents' legend above them. */
export function OverTime({
  days,
  hours,
  page,
  metric,
  scope,
}: {
  days: DayTotal[]
  hours: HourTotals | null
  page: PageData
  metric: Metric
  scope: UsageScope
}) {
  const { t, i18n } = useTranslation('usage')
  const rangeText = useRangeText()
  const hourText = useHourText(hours?.zoned ?? false)
  const kind = metricKind(metric, scope)
  const text = useMetricText(kind)
  // Figures for another range or source are on their way.
  const late = useLate(
    useUsageStore(
      (s) =>
        s.loading &&
        !!s.page &&
        (s.page.filters.range !== s.filters.range || s.page.filters.scope !== s.filters.scope),
    ),
  )
  const { unit, bars } = useMemo(
    () =>
      hours
        ? { unit: 'hour' as const, bars: hourBars(hours.totals, hours.starts, metric, scope) }
        : trend(days, page.range, page.firstDay, metric, scope),
    [hours, days, page.range, page.firstDay, metric, scope],
  )
  const series = useMemo(
    () =>
      seriesOf(
        bars,
        sortAgentIds(new Set(bars.flatMap((bar) => Object.keys(bar.byAgent))) as Set<AgentId>),
      ),
    [bars],
  )
  // What the legend hides holds until any filter changes, even back to an earlier value: the agent
  // at once, the range or source once its figures arrive, so the chart still drawn while they load
  // keeps its series and scale.
  const agentGeneration = useUsageStore((s) => s.generations.agent)
  const drawn = useMemo(
    () => ({ agent: agentGeneration, figures: page.generation }),
    [agentGeneration, page.generation],
  )
  const [legend, setLegend] = useState<LegendChoice>({ ...drawn, hidden: NO_SERIES })
  const hidden = legendHides(legend, drawn)
  const shown = useMemo(() => shownSeries(series, hidden), [series, hidden])
  const toggle = useCallback(
    (chosen: AgentId[]) => setLegend({ ...drawn, hidden: legendHidden(series, chosen, hidden) }),
    [drawn, series, hidden],
  )
  const totals = useMemo(() => shownTotals(bars, shown), [bars, shown])
  const max = Math.max(0, ...totals)
  // Re-renders as an hour begins; a range of days never does.
  const future = useClock((now) => (hours ? bars.filter((bar) => bar.from > now).length : 0))
  const [chosen, setChosen] = useState<number | null>(null)
  const at = chosen !== null && chosen < bars.length - future ? chosen : null
  const describe = (bar: TrendBar) =>
    unit === 'hour'
      ? hourText(bar.from, bar.to)
      : unit === 'day'
        ? dayText(bar.from)
        : unit === 'month' && wholeMonth(bar)
          ? new Intl.DateTimeFormat(i18n.language, { month: 'short', year: 'numeric' }).format(
              bar.from,
            )
          : rangeText(bar.from, bar.to)
  const froms = useMemo(() => bars.map((bar) => bar.from), [bars])
  const axisText = useMemo(() => {
    if (unit === 'hour') {
      const time = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' })
      return (i: number) => time.format(froms[i]!)
    }
    const date: Intl.DateTimeFormatOptions =
      unit === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' }
    const plain = new Intl.DateTimeFormat(i18n.language, date)
    const dated = new Intl.DateTimeFormat(i18n.language, { ...date, year: 'numeric' })
    return (i: number, previous: number | null) =>
      (namesYear(froms, i, previous) ? dated : plain).format(froms[i]!)
  }, [unit, froms, i18n.language])
  const pickHours = useMemo(
    () => (unit === 'hour' ? (step: number) => hourLabels(froms, step) : undefined),
    [unit, froms],
  )
  const parts = (bar: TrendBar) => shown.filter((id) => (bar.byAgent[id] ?? 0) > 0)
  const bar = at === null ? null : bars[at]!
  const spoken =
    bar &&
    [
      text.sentence(describe(bar), totals[at!]!),
      ...(series.length > 1 ? parts(bar).map((id) => text.part(id, bar.byAgent[id]!)) : []),
    ].join(' ')
  const tooltip = (index: number) => {
    const bar = bars[index]!
    const rows = parts(bar)
    return (
      <>
        <span className="font-semibold text-primary">{describe(bar)}</span>
        {rows.length === 0 ? (
          <span>{t('figures.none')}</span>
        ) : (
          rows.map((id) => (
            <span key={id} className="flex justify-between gap-3">
              <span className="truncate">{agentName(id)}</span>
              <span className="text-primary tabular-nums">{text.short(bar.byAgent[id]!)}</span>
            </span>
          ))
        )}
      </>
    )
  }
  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PanelTitle>{t('trend.title')}</PanelTitle>
        <SegmentedControl
          aria-label={t('page.metric')}
          value={metric}
          onChange={(value) => setUsageFilters({ metric: value as Metric })}
          itemClassName={SEGMENT}
          segments={[
            { value: 'tokens', label: t('metrics.tokens') },
            { value: 'requests', label: t(`metrics.${metricKind('requests', scope)}`) },
            { value: 'cost', label: t('metrics.cost') },
          ]}
        />
        <span className="flex-1" />
        {!late && series.length > 1 && (
          <TrendLegend
            series={series}
            shown={shown}
            label={t('trend.legend')}
            keepOne={t('trend.keepOne')}
            onChange={toggle}
          />
        )}
      </div>
      {late ? (
        <Skeleton className="h-45" />
      ) : max === 0 ? (
        <p className="flex h-45 items-center justify-center text-control text-tertiary shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-default)]">
          {kind === 'cost' && days.some((day) => day.total > 0) ? t('noCost') : t('noUsage')}
        </p>
      ) : (
        <TrendChart
          bars={bars}
          series={shown}
          max={max}
          start={busiest(totals)}
          chosen={at}
          label={t(TREND_TITLE[kind][unit])}
          future={future}
          tooltip={tooltip}
          onChoose={setChosen}
        />
      )}
      {late || max === 0 ? (
        <span className="mt-2 h-4" />
      ) : (
        <TrendAxis
          count={bars.length}
          anchor={unit === 'hour' ? 'start' : 'end'}
          steps={unit === 'hour' ? HOUR_STEPS : undefined}
          pick={pickHours}
          text={axisText}
        />
      )}
      <span role="status" className="sr-only">
        {!late && spoken}
      </span>
    </Panel>
  )
}
