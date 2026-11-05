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
import { Panel, PanelTitle } from './panel'
import { useMetricText, useRangeText, wholePercent } from './text'

/** The hours in a row the line under the chart sums: a working day's. */
const SPAN = 9
/** The hours the axis names. */
const LABELED = [0, 6, 12, 18]
/** Jan 1, 2026, whose hours stand for every day's. */
const A_DAY = new Date(2026, 0, 1).getTime()
const atHour = (hour: number) => A_DAY + hour * 3_600_000
const NO_HOURS: HourUsage[] = []

/**
 * Beside the breakdown, the range by the hour of the day it was used in, the busiest hour in the
 * fox orange. A one-day range's trend is by hour already, so then it covers the last 30 days.
 */
export function TimeOfDay({
  page,
  agent,
  metric,
  scope,
}: {
  page: PageData
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
  return (
    <Panel className="pt-3.5 pb-3.5">
      <div className="mb-3 flex min-h-7.5 flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <PanelTitle>{t('timeOfDay.title')}</PanelTitle>
        <span className="min-w-0 flex-1 truncate text-hint text-tertiary">
          {oneDay(page.range)
            ? t('timeOfDay.byHourOver', {
                metric: t(`timeOfDay.by.${kind}`),
                range: rangeText(page.clock.from, page.clock.to),
              })
            : t(`timeOfDay.by.${kind}`)}
        </span>
        {peak !== null && (
          <span className="text-hint text-tertiary">
            {t('timeOfDay.busiest')}{' '}
            <span className="font-semibold text-primary">{hourSpan(peak)}</span>
          </span>
        )}
      </div>
      {peak === null ? (
        <p className="flex flex-1 items-center justify-center py-12 text-control text-tertiary">
          {kind === 'cost' && tokensUsed ? t('noCost') : t('noUsage')}
        </p>
      ) : (
        <div className="flex flex-1 flex-col justify-end gap-2">
          <div
            role="img"
            aria-label={t('timeOfDay.label', { hour: hourSpan(peak) })}
            className="grid h-29.5 grid-cols-24 items-end gap-x-0.75 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-default)]"
          >
            {values.map((value, h) => (
              <Tooltip key={h}>
                <TooltipTrigger render={<span className="flex h-full items-end" />}>
                  {value > 0 && (
                    <span
                      className="block w-full rounded-t-[3px]"
                      style={{
                        height: `${Math.max(2, (value / max) * 100)}%`,
                        backgroundColor: h === peak ? 'var(--share-2)' : 'var(--share-4)',
                      }}
                    />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {hourSpan(h)} · {value > 0 ? text.short(value) : t('figures.none')}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div aria-hidden className="grid grid-cols-24 gap-x-0.75">
            {values.map((_, h) => (
              <span key={h} className="text-caption whitespace-nowrap text-tertiary">
                {LABELED.includes(h) ? hour.format(atHour(h)) : ''}
              </span>
            ))}
          </div>
          {span && (
            <p className="mt-0.5 text-hint text-tertiary">
              {t(`timeOfDay.span.${kind}`, {
                share: wholePercent(span.share),
                from: hour.format(atHour(span.from)),
                to: hour.format(atHour((span.from + SPAN) % 24)),
              })}
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}
