import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { HourUsage, UsageScope } from '@shared/usage'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { UsagePage as PageData } from '@renderer/stores/usage'
import {
  busiestHours,
  hourValues,
  metricKind,
  oneDay,
  type AgentFilter,
  type Metric,
} from './model'
import { useMetricText, useRangeText, wholePercent } from './text'

/** The hours in a row the line under the chart sums: a working day's. */
const SPAN = 9
/** The hours the axis names. */
const LABELED = [0, 6, 12, 18, 23]
/** Jan 1, 2026, whose hours stand for every day's. */
const A_DAY = new Date(2026, 0, 1).getTime()
const atHour = (hour: number) => A_DAY + hour * 3_600_000
const NO_HOURS: HourUsage[] = []

/**
 * Beside the activity, the range by the hour of the day it was used in, the busiest hour darker. A one-day range's trend is by hour already, so then it covers the last 30 days.
 */
export function TimeOfDay({
  page,
  agent,
  metric,
  scope,
  rangeLabel,
}: {
  page: PageData
  /** The chosen range, as the page's head names it. */
  rangeLabel: string
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
}) {
  const { t, i18n } = useTranslation('usage')
  const kind = metricKind(metric, scope)
  const text = useMetricText(kind)
  const rangeText = useRangeText()
  // A host from before the hours of the day answers without them.
  const clock = page.summary.clock ?? NO_HOURS
  const values = useMemo(
    () => hourValues(clock, agent, metric, scope),
    [clock, agent, metric, scope],
  )
  const max = Math.max(0, ...values)
  const peak = max > 0 ? values.indexOf(max) : null
  const span = busiestHours(values, SPAN)
  const hour = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric' }),
    [i18n.language],
  )
  const hourSpan = (from: number) =>
    t('trend.hour', { from: hour.format(atHour(from)), to: hour.format(atHour((from + 1) % 24)) })
  const tokensUsed = useMemo(
    () => clock.some((row) => agent === 'all' || row.agentId === agent),
    [clock, agent],
  )
  const title = oneDay(page.range)
    ? t('timeOfDay.byHourOver', {
        metric: t(`timeOfDay.by.${kind}`),
        range: rangeText(page.clock.from, page.clock.to),
      })
    : t('timeOfDay.byHourOver', { metric: t(`timeOfDay.by.${kind}`), range: rangeLabel })
  return (
    <div className="k-u-card k-u-tod">
      <span className="k-u-cap">{t('timeOfDay.title')}</span>
      <span className="k-u-tod__title">
        {title}
        {peak !== null && (
          <b>
            {t('timeOfDay.busiest')} {hour.format(atHour(peak))}
          </b>
        )}
      </span>
      {peak === null ? (
        <p className="k-u-tod__empty">
          {kind === 'cost' && tokensUsed ? t('noCost') : t('noUsage')}
        </p>
      ) : (
        <>
          <div
            role="img"
            aria-label={t('timeOfDay.label', { hour: hourSpan(peak) })}
            className="k-u-tod__bars"
          >
            {values.map((value, h) => (
              <Tooltip key={h}>
                <TooltipTrigger
                  render={<span className="k-u-tod__bar" data-peak={h === peak || undefined} />}
                >
                  <i style={{ height: `${value > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
                </TooltipTrigger>
                <TooltipContent>
                  {hourSpan(h)} · {value > 0 ? text.short(value) : t('figures.none')}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <span aria-hidden className="k-u-tod__axis">
            {LABELED.map((h) => (
              <span key={h}>{hour.format(atHour(h))}</span>
            ))}
          </span>
          {span && (
            <p className="k-u-tod__line">
              {t(`timeOfDay.span.${kind}`, {
                share: wholePercent(span.share),
                from: hour.format(atHour(span.from)),
                to: hour.format(atHour((span.from + SPAN) % 24)),
              })}
            </p>
          )}
        </>
      )}
    </div>
  )
}
