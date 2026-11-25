import { useMemo, useState, type PointerEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { HourUsage, UsageScope } from '@shared/usage'
import type { UsagePage as PageData } from '@renderer/stores/usage'
import { ChartTip, TipRow } from './chart'
import {
  busiestHours,
  hourValues,
  metricKind,
  oneDay,
  quietestHour,
  type AgentFilter,
  type Metric,
} from './model'
import { useMetricText, useRangeText, wholePercent } from './text'

/** The hours in a row the band behind the bars and the line under them sum: a working day's. */
const SPAN = 9
/** The hours the axis names. */
const LABELED = [0, 6, 12, 18]
/** Jan 1, 2026, whose hours stand for every day's. */
const A_DAY = new Date(2026, 0, 1).getTime()
const atHour = (hour: number) => A_DAY + hour * 3_600_000
const NO_HOURS: HourUsage[] = []
const LAST_DAYS: readonly string[] = ['7', '30', '90']

/**
 * Beside the activity, the range by the hour of the day it was used in: the busiest hour in the
 * fox orange, the busiest nine hours in a row shaded behind the bars. A one-day range's trend is
 * by hour already, so then it covers the last 30 days.
 */
export function TimeOfDay({
  page,
  agent,
  metric,
  scope,
  rangeLabel,
  className,
}: {
  page: PageData
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
  /** The chosen range, as the page names it. */
  rangeLabel: string
  className?: string
}) {
  const { t, i18n } = useTranslation('usage')
  const kind = metricKind(metric, scope)
  const text = useMetricText(kind)
  const rangeText = useRangeText()
  const [tip, setTip] = useState<{ hour: number; at: DOMRect } | null>(null)
  // A host from before the hours of the day answers without them.
  const clock = page.summary.clock ?? NO_HOURS
  const values = useMemo(
    () => hourValues(clock, agent, metric, scope),
    [clock, agent, metric, scope],
  )
  const max = Math.max(0, ...values)
  const peak = max > 0 ? values.indexOf(max) : null
  const span = busiestHours(values, SPAN)
  const quiet = quietestHour(values)
  const hour = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric' }),
    [i18n.language],
  )
  // A one-day range covers the last 30 days here, and the ranges of the last days say so too.
  const lastDays = oneDay(page.range) || LAST_DAYS.includes(page.filters.range.kind)
  const hourSpan = (from: number) =>
    t('trend.hour', { from: hour.format(atHour(from)), to: hour.format(atHour((from + 1) % 24)) })
  const tokensUsed = useMemo(
    () => clock.some((row) => agent === 'all' || row.agentId === agent),
    [clock, agent],
  )
  // The band may run across midnight, as two pieces.
  const bands = span
    ? span.from + SPAN <= 24
      ? [[span.from, span.from + SPAN]]
      : [
          [span.from, 24],
          [0, span.from + SPAN - 24],
        ]
    : []
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-hour]')
    if (!target) return
    const h = Number(target.dataset.hour)
    if (tip?.hour === h) return
    const bar = target.firstElementChild?.getBoundingClientRect() ?? target.getBoundingClientRect()
    setTip({ hour: h, at: bar })
  }
  return (
    <section className={`k-u-card k-u-tod ${className ?? ''}`} aria-labelledby="time-of-day-title">
      <header className="k-u-card__head">
        <h3 id="time-of-day-title">{t('timeOfDay.title')}</h3>
        <span className="k-u-meta" title={rangeText(page.clock.from, page.clock.to)}>
          {lastDays
            ? t('timeOfDay.lastDays', {
                count: Math.round((page.clock.to - page.clock.from) / 86_400_000),
              })
            : rangeLabel}
        </span>
      </header>
      {peak === null ? (
        <p className="k-u-plot__empty">
          {kind === 'cost' && tokensUsed ? t('noCost') : t('noUsage')}
        </p>
      ) : (
        <>
          <div className="k-u-tod__plot">
            <div
              role="img"
              aria-label={t('timeOfDay.label', { hour: hourSpan(peak) })}
              className="k-u-tod__bars"
              onPointerMove={point}
              onPointerLeave={() => setTip(null)}
            >
              {bands.map(([from, to]) => (
                <span
                  key={from}
                  aria-hidden
                  className="k-u-tod__band"
                  style={{
                    left: `${(from! / 24) * 100}%`,
                    width: `${((to! - from!) / 24) * 100}%`,
                  }}
                />
              ))}
              {values.map((value, h) => (
                <span
                  key={h}
                  data-hour={h}
                  className="k-u-tod__bar"
                  data-peak={h === peak || undefined}
                  data-on={tip?.hour === h || undefined}
                >
                  <i style={{ height: `${value > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
                </span>
              ))}
            </div>
            <span aria-hidden className="k-u-tod__axis">
              {LABELED.map((h) => (
                <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
                  {hour.format(atHour(h))}
                </span>
              ))}
            </span>
          </div>
          <footer className="k-u-foot">
            <span>
              <Trans
                t={t}
                i18nKey="timeOfDay.busiest"
                values={{ hour: hour.format(atHour(peak)) }}
                components={{ b: <b /> }}
              />
            </span>
            {span && (
              <span>
                <i aria-hidden className="k-u-swatch" data-band="" />
                <Trans
                  t={t}
                  i18nKey={`timeOfDay.holds.${kind}`}
                  values={{
                    from: hour.format(atHour(span.from)),
                    to: hour.format(atHour((span.from + SPAN) % 24)),
                    share: wholePercent(span.share),
                  }}
                  components={{ b: <b /> }}
                />
              </span>
            )}
            {quiet !== null && (
              <span>
                <Trans
                  t={t}
                  i18nKey="timeOfDay.quietest"
                  values={{ hour: hour.format(atHour(quiet)) }}
                  components={{ b: <b /> }}
                />
              </span>
            )}
          </footer>
        </>
      )}
      <ChartTip at={tip?.at ?? null}>
        {tip && (
          <TipRow
            label={hourSpan(tip.hour)}
            value={values[tip.hour]! > 0 ? text.short(values[tip.hour]!) : t('figures.none')}
          />
        )}
      </ChartTip>
    </section>
  )
}
