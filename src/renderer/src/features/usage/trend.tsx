import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { sortAgentIds, type AgentId } from '@shared/thread'
import { useClock } from '@renderer/lib/use-now'
import { count, usd } from '@renderer/lib/format'
import { ChartTip, TipRow } from './chart'
import {
  activeAverage,
  legendHidden,
  seriesOf,
  shownSeries,
  type MetricKind,
  type TrendBar,
  type TrendUnit,
} from './model'
import { niceStep, rectIn, topRounded, useSize } from './plot'
import { useAgentColor, usageAgentName } from './series'
import { useMetricText, usePeriodText } from './text'

/** What the chart counts and by what unit. */
const TITLE = {
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
} as const satisfies Record<MetricKind, Record<TrendUnit, string>>

const PAD_LEFT = 40
const PAD_TOP = 22
const PAD_BOTTOM = 20
/** The least room between two of the axis's dates. */
const LABEL_GAP = 52
/** How far apart the segments of a stacked bar sit. */
const SEGMENT_GAP = 1.5

/**
 * The range over time, stacked by agent: by hour for one day, else by day, week or month. Over it
 * an average: for today each hour's daily average over the last 30 days, else a dashed line at the
 * average of the periods with any. Days are shaded on weekends; today's hours still to come are
 * empty after a line at now. The legend's agents show their totals and hide or show their part.
 */
export function TrendCard({
  unit,
  bars,
  begun,
  zoned,
  kind,
  hourAverage,
  tokensUsed,
  today,
  firstDay,
  className,
}: {
  unit: TrendUnit
  bars: TrendBar[]
  /** The end of the hour under way for a one-day range; null for a range of days. */
  begun: number | null
  zoned: boolean
  kind: MetricKind
  /** For today, each local hour's daily average over the last 30 days. */
  hourAverage: readonly number[] | null
  tokensUsed: boolean
  today: number
  /** The locale's first day of the week, whose days the axis names. */
  firstDay: number
  className?: string
}) {
  const { t } = useTranslation('usage')
  const color = useAgentColor()
  const text = useMetricText(kind)
  const format = kind === 'cost' ? usd : count
  const labels = usePeriodText(unit, bars, zoned)
  const [plot, size] = useSize<HTMLDivElement>()
  const series = useMemo(
    () =>
      seriesOf(
        bars,
        sortAgentIds(new Set(bars.flatMap((bar) => Object.keys(bar.byAgent))) as Set<AgentId>),
      ),
    [bars],
  )
  // What the legend hides, until the agents drawn change.
  const drawn = series.join(' ')
  const [legend, setLegend] = useState<{ drawn: string; hidden: readonly AgentId[] }>({
    drawn,
    hidden: [],
  })
  const hidden = legend.drawn === drawn ? legend.hidden : []
  const shown = shownSeries(series, hidden)
  const [chosen, setChosen] = useState<number | null>(null)
  const [tip, setTip] = useState<DOMRect | null>(null)
  // Where now falls, to the five minutes, for today's line.
  const now = useClock((at) => Math.floor(at / 300_000) * 300_000)

  const later = (bar: TrendBar) => begun !== null && bar.from >= begun
  const past = bars.filter((bar) => !later(bar))
  const totals = useMemo(() => {
    const sums: Partial<Record<AgentId, number>> = {}
    for (const bar of bars) {
      for (const [id, value] of Object.entries(bar.byAgent) as [AgentId, number][]) {
        sums[id] = (sums[id] ?? 0) + value
      }
    }
    return sums
  }, [bars])
  const average = hourAverage ? null : activeAverage(past.map((bar) => bar.total))
  const hourOf = (bar: TrendBar) => new Date(bar.from).getHours()
  const averageAt = (bar: TrendBar) => (hourAverage ? (hourAverage[hourOf(bar)] ?? 0) : average)
  const busiest = past.reduce<TrendBar | null>(
    (best, bar) => (bar.total > 0 && (!best || bar.total > best.total) ? bar : best),
    null,
  )
  const active = past.filter((bar) => bar.total > 0).length
  const perPeriod = activeAverage(past.map((bar) => bar.total))
  const above = hourAverage
    ? past.filter((bar) => bar.total > 0 && bar.total > (averageAt(bar) ?? 0)).length
    : null
  const empty = !past.some((bar) => bar.total > 0)

  // The scale holds every agent's part and the averages, so hiding one moves nothing else.
  const width = size.width
  const height = size.height
  const plotW = Math.max(0, width - PAD_LEFT)
  const plotH = Math.max(0, height - PAD_TOP - PAD_BOTTOM)
  const top = Math.max(...bars.map((bar) => bar.total), ...(hourAverage ?? []), average ?? 0, 0)
  const step = niceStep(top / 2)
  const yMax = top > 0 ? Math.ceil(top / step) * step : 1
  const y = (value: number) => PAD_TOP + plotH - (value / yMax) * plotH
  const n = bars.length
  const slot = n > 0 ? plotW / n : 0
  const barW = Math.max(1, Math.min(22, slot * (unit === 'hour' ? 0.64 : 0.7)))
  const xOf = (i: number) => PAD_LEFT + slot * i

  const stackTop = (bar: TrendBar) => shown.reduce((sum, id) => sum + (bar.byAgent[id] ?? 0), 0)
  const point = (index: number, target: SVGSVGElement | null) => {
    setChosen(index)
    if (!target || index < 0) return setTip(null)
    const bar = bars[index]!
    const value = later(bar) ? 0 : stackTop(bar)
    setTip(rectIn(target, xOf(index) + slot / 2, y(value) - 2, 0, 0))
  }
  const svgOf = () => plot.current?.querySelector('svg') ?? null
  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = Math.floor((event.clientX - box.left - PAD_LEFT) / slot)
    if (index < 0 || index >= n) {
      setChosen(null)
      return setTip(null)
    }
    if (index !== chosen) point(index, event.currentTarget)
  }
  const onKey = (event: KeyboardEvent) => {
    if (n === 0) return
    const from = chosen ?? n - 1
    const next =
      event.key === 'ArrowLeft'
        ? from - 1
        : event.key === 'ArrowRight'
          ? from + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? n - 1
              : null
    if (next === null) return
    event.preventDefault()
    point(Math.min(n - 1, Math.max(0, next)), svgOf())
  }

  const ticks: number[] = []
  for (let value = 0; value <= yMax + step / 1000; value += step) ticks.push(value)
  const axis = axisLabels(unit, bars, labels.short, slot, today, firstDay)
  const nowIndex = begun === null ? -1 : bars.findIndex((bar) => bar.from <= now && now < bar.to)
  const nowX =
    nowIndex < 0
      ? null
      : xOf(nowIndex) +
        slot * ((now - bars[nowIndex]!.from) / (bars[nowIndex]!.to - bars[nowIndex]!.from))
  const peak = busiest && !later(busiest) ? bars.indexOf(busiest) : -1
  const title = t(TITLE[kind][unit])
  const chosenBar = chosen === null ? null : bars[chosen]

  return (
    <section className={`k-u-card k-u-trend ${className ?? ''}`} aria-label={title}>
      <header className="k-u-card__head">
        <h3>{title}</h3>
        <span role="group" aria-label={t('trend.legend')} className="k-u-legend">
          {series.map((id) => {
            const on = shown.includes(id)
            const last = on && shown.length === 1
            const item = (
              <>
                <i style={{ background: color(id) }} />
                {usageAgentName(id)}
                <b className="k-num">{format(totals[id] ?? 0)}</b>
              </>
            )
            return series.length > 1 ? (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                title={last ? t('trend.keepOne') : undefined}
                className="k-u-legend__item"
                onClick={() =>
                  setLegend({
                    drawn,
                    hidden: legendHidden(
                      series,
                      on ? shown.filter((other) => other !== id) : [...shown, id],
                      hidden,
                    ),
                  })
                }
              >
                {item}
              </button>
            ) : (
              <span key={id} className="k-u-legend__item">
                {item}
              </span>
            )
          })}
          {!empty && (
            <span className="k-u-legend__avg" data-step={hourAverage ? '' : undefined}>
              <i />
              {t(`trend.average.${unit}`)}
            </span>
          )}
        </span>
      </header>
      <div
        ref={plot}
        className="k-u-plot"
        tabIndex={empty ? undefined : 0}
        aria-label={empty ? undefined : t('trend.plot', { title })}
        onKeyDown={onKey}
        onFocus={(event) => {
          if (event.target.matches(':focus-visible') && n > 0)
            point(peak >= 0 ? peak : n - 1, svgOf())
        }}
        onBlur={() => {
          setChosen(null)
          setTip(null)
        }}
      >
        {empty ? (
          <p className="k-u-plot__empty">
            {kind === 'cost' && tokensUsed ? t('noCost') : t('noUsage')}
          </p>
        ) : (
          width > 0 &&
          height > 0 && (
            <svg
              aria-hidden
              width={width}
              height={height}
              onPointerMove={onPointer}
              onPointerLeave={() => {
                setChosen(null)
                setTip(null)
              }}
            >
              {unit === 'day' &&
                bars.map((bar, i) => {
                  const weekday = new Date(bar.from).getDay()
                  return weekday === 0 || weekday === 6 ? (
                    <rect
                      key={`w${i}`}
                      className="k-u-plot__weekend"
                      x={xOf(i)}
                      y={PAD_TOP - 4}
                      width={slot}
                      height={plotH + 4}
                    />
                  ) : null
                })}
              {ticks.map((value) => (
                <g key={value}>
                  <line
                    className={value === 0 ? 'k-u-plot__base' : 'k-u-plot__grid'}
                    x1={PAD_LEFT}
                    x2={width}
                    y1={y(value)}
                    y2={y(value)}
                  />
                  <text
                    className="k-u-plot__label"
                    x={PAD_LEFT - 8}
                    y={y(value) + 3.5}
                    textAnchor="end"
                  >
                    {value === 0 ? '0' : format(value)}
                  </text>
                </g>
              ))}
              {chosen !== null && (
                <rect
                  className="k-u-plot__hover"
                  x={xOf(chosen)}
                  y={PAD_TOP - 4}
                  width={slot}
                  height={plotH + 4}
                />
              )}
              {bars.map((bar, i) => {
                if (later(bar)) return null
                const x = xOf(i) + (slot - barW) / 2
                const parts = shown
                  .map((id) => ({ id, value: bar.byAgent[id] ?? 0 }))
                  .filter((part) => part.value > 0)
                let sum = 0
                return parts.map((part, k) => {
                  const y0 = y(sum)
                  sum += part.value
                  const y1 = y(sum)
                  const h = Math.max(y0 - y1 - (k > 0 ? SEGMENT_GAP : 0), 0.8)
                  return k === parts.length - 1 ? (
                    <path
                      key={`${i}-${part.id}`}
                      d={topRounded(x, y1, barW, h, Math.min(3, barW / 2))}
                      fill={color(part.id)}
                    />
                  ) : (
                    <rect
                      key={`${i}-${part.id}`}
                      x={x}
                      y={y1}
                      width={barW}
                      height={h}
                      fill={color(part.id)}
                    />
                  )
                })
              })}
              {hourAverage ? (
                <path
                  className="k-u-plot__avg"
                  d={bars
                    .map((bar, i) => {
                      const level = y(averageAt(bar) ?? 0)
                      return `M${xOf(i) + 2},${level}H${xOf(i + 1) - 2}`
                    })
                    .join('')}
                />
              ) : (
                average !== null && (
                  <line
                    className="k-u-plot__avg"
                    data-dashed=""
                    x1={PAD_LEFT}
                    x2={width}
                    y1={y(average)}
                    y2={y(average)}
                  />
                )
              )}
              {nowX !== null && (
                <g className="k-u-plot__now">
                  <line x1={nowX} x2={nowX} y1={PAD_TOP - 4} y2={y(0)} />
                  <text x={nowX - 5} y={PAD_TOP + 2} textAnchor="end">
                    {t('trend.now')}
                  </text>
                </g>
              )}
              {peak >= 0 && (
                <text
                  className="k-u-plot__peak"
                  x={xOf(peak) + slot / 2}
                  y={y(stackTop(bars[peak]!)) - 7}
                  textAnchor="middle"
                >
                  {format(stackTop(bars[peak]!))}
                </text>
              )}
              {axis.map(({ index, text: label, end }) => (
                <text
                  key={index}
                  className="k-u-plot__label"
                  data-today={end || undefined}
                  x={end ? width : xOf(index) + slot / 2}
                  y={height - 5}
                  textAnchor={end ? 'end' : 'middle'}
                >
                  {end ? t('trend.today') : label}
                </text>
              ))}
            </svg>
          )
        )}
        <ChartTip at={tip}>
          {chosenBar && (
            <>
              <span className="k-u-tip__title">{labels.long[chosen!]}</span>
              {later(chosenBar) ? (
                <TipRow label={t('trend.toCome')} value="" />
              ) : (
                <>
                  {shown
                    .filter((id) => (chosenBar.byAgent[id] ?? 0) > 0)
                    .map((id) => (
                      <TipRow
                        key={id}
                        color={color(id)}
                        label={usageAgentName(id)}
                        value={format(chosenBar.byAgent[id]!)}
                      />
                    ))}
                  {stackTop(chosenBar) > 0 ? (
                    shown.filter((id) => (chosenBar.byAgent[id] ?? 0) > 0).length > 1 && (
                      <TipRow label={t('trend.total')} value={format(stackTop(chosenBar))} strong />
                    )
                  ) : (
                    <TipRow label={t('figures.none')} value="" />
                  )}
                  {hourAverage && (
                    <TipRow
                      label={t('trend.average.hour')}
                      value={format(averageAt(chosenBar) ?? 0)}
                    />
                  )}
                </>
              )}
            </>
          )}
        </ChartTip>
        <span role="status" className="sr-only">
          {chosenBar ? text.sentence(labels.long[chosen!]!, chosenBar.total) : ''}
        </span>
      </div>
      {!empty && (
        <footer className="k-u-foot">
          {busiest && (
            <span>
              <Trans
                t={t}
                i18nKey="trend.busiest"
                values={{
                  when:
                    unit === 'hour'
                      ? labels.short[bars.indexOf(busiest)]
                      : labels.long[bars.indexOf(busiest)],
                  value: format(busiest.total),
                }}
                components={{ b: <b /> }}
              />
            </span>
          )}
          <span>
            <Trans
              t={t}
              i18nKey={`trend.active.${unit}`}
              values={{ active, count: past.length }}
              components={{ b: <b /> }}
            />
          </span>
          {perPeriod !== null && (
            <span>
              <Trans
                t={t}
                i18nKey={`trend.per.${unit}`}
                values={{ value: format(perPeriod) }}
                components={{ b: <b /> }}
              />
            </span>
          )}
          {above !== null && (
            <span>
              <Trans
                t={t}
                i18nKey="trend.above"
                values={{ count: above }}
                components={{ b: <b /> }}
              />
            </span>
          )}
          {unit === 'day' && (
            <span className="k-u-foot__end">
              <i className="k-u-swatch" data-weekend="" />
              {t('trend.weekends')}
            </span>
          )}
        </footer>
      )}
    </section>
  )
}

/**
 * The axis's dates: every third hour of a day; for days, each week's first and today, or every
 * day when there is room; for weeks the first of each month; for months each. Any that would
 * crowd the one before is left out.
 */
function axisLabels(
  unit: TrendUnit,
  bars: readonly TrendBar[],
  short: readonly string[],
  slot: number,
  today: number,
  firstDay: number,
): { index: number; text: string; end: boolean }[] {
  const n = bars.length
  const day = (i: number) => new Date(bars[i]!.from)
  const candidates: number[] = []
  for (let i = 0; i < n; i++) {
    const at = day(i)
    if (unit === 'hour') {
      if (at.getHours() % (slot * 3 >= LABEL_GAP ? 3 : 6) === 0 && at.getMinutes() === 0) {
        candidates.push(i)
      }
    } else if (unit === 'day') {
      if (slot >= LABEL_GAP || at.getDay() === firstDay || i === 0) candidates.push(i)
    } else if (unit === 'week') {
      if (i === 0 || at.getMonth() !== day(i - 1).getMonth()) candidates.push(i)
    } else {
      candidates.push(i)
    }
  }
  // The last day of a range of days is named today, at the axis's end, when it is.
  const last = unit === 'day' && n > 1 && bars[n - 1]!.from === today ? n - 1 : -1
  const out: { index: number; text: string; end: boolean }[] = []
  let at = -Infinity
  const endAt = last >= 0 ? last * slot + slot : Infinity
  for (const index of candidates) {
    const x = index * slot + slot / 2
    if (x - at < LABEL_GAP || endAt - x < LABEL_GAP) continue
    if (index === last) continue
    out.push({ index, text: short[index]!, end: false })
    at = x
  }
  if (last >= 0) out.push({ index: last, text: short[last]!, end: true })
  return out
}
