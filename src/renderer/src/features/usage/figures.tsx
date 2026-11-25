// The four figures under the plan limits: tokens, requests, the estimated cost and what came from
// the prompt cache, whatever the metric, each set against the period before.

import { useMemo, useState, type PointerEvent, type ReactNode } from 'react'
import {
  Activity01Icon,
  ArrowUpRight01Icon,
  Coins01Icon,
  DatabaseIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { UsageScope } from '@shared/usage'
import { Icon } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { clockTime, count, percent, usd } from '@renderer/lib/format'
import type { UsagePage as PageData } from '@renderer/stores/usage'
import { ChartTip, TipRow } from './chart'
import { Count } from './count'
import {
  addDays,
  change,
  dayTotals,
  figures,
  fromCache,
  metricKind,
  metricValue,
  tokenParts,
  trend,
  type AgentFilter,
  type DayTotal,
  type Metric,
  type TokenPart,
} from './model'
import { COMPOSITION, PART_COLOR, rectIn, topRounded } from './plot'
import { changePercent, dayText, sharePercent, usePeriodText, useRangeText } from './text'

/** The days the small bars show for a one-day range, whose trend is by hour: the week to it. */
const WEEK = 7
const BARS_WIDTH = 96
const BARS_HEIGHT = 30

/** One day's totals per hour, the hour starts they were summed over, and whether clocks change. */
export interface HourTotals {
  totals: DayTotal[]
  starts: number[]
  zoned: boolean
}

export function FigureCards({
  page,
  days,
  hours,
  begun,
  agent,
  scope,
}: {
  page: PageData
  /** The page's days for the agents the filter keeps. */
  days: DayTotal[]
  hours: HourTotals | null
  /** The end of the hour under way, for a one-day range. */
  begun: number
  agent: AgentFilter
  scope: UsageScope
}) {
  const { t } = useTranslation('usage')
  const rangeText = useRangeText()
  const { range, compare } = page
  const requestKind = metricKind('requests', scope) as 'requests' | 'turns'
  const facts = useMemo(() => figures(days, range), [days, range])
  // A day so far is counted by its hours, any other range by its days.
  const span = useMemo(
    () => (hours ? figures(hours.totals, { from: hours.starts[0]!, to: begun }) : facts),
    [hours, begun, facts],
  )
  const before = useMemo(() => {
    if (compare.kind === 'before') return figures(days, compare.range)
    if (compare.kind === 'sameTime' && page.sameTime) {
      const starts = [compare.range.from, compare.range.to]
      return figures(dayTotals(page.sameTime, starts, agent), compare.range)
    }
    return null
  }, [compare, days, page.sameTime, agent])

  // The small bars: the week up to a one-day range, else the trend's periods.
  const week = useMemo(
    () =>
      hours
        ? days.filter((d) => d.day >= addDays(range.from, 1 - WEEK) && d.day <= range.from)
        : null,
    [hours, days, range.from],
  )
  const periods = useMemo(() => {
    const of = (metric: Metric) =>
      week
        ? week.map((d) => ({
            from: d.day,
            to: addDays(d.day, 1),
            total: metricValue(d.parts, metric, scope) ?? 0,
          }))
        : trend(days, range, page.firstDay, metric, scope).bars
    return { tokens: of('tokens'), requests: of('requests'), cost: of('cost') }
  }, [week, days, range, page.firstDay, scope])
  const unit = week ? 'day' : trend(days, range, page.firstDay).unit
  const labels = usePeriodText(unit, periods.tokens).long
  const caption = t(`figures.bars.${unit}`, {
    count: periods.tokens.length,
  })

  const used = facts.activeDays > 0
  const requests = metricValue(facts.parts, 'requests', scope) ?? 0
  const cost = facts.parts.cost
  const per = hours ? 'hour' : 'day'
  const perPeriod = (value: number) => (span.activeDays > 0 ? value / span.activeDays : null)
  const unpriced = facts.parts.unpricedTokens
  const cache = fromCache(facts.parts)

  /** The line that sets a figure against the period before, or says since when it counts. */
  const versus = (current: number, previous: number | null): Versus | null => {
    if (compare.kind === 'since') {
      return { line: t('figures.since', { date: dayText(compare.from) }), when: null }
    }
    if (previous === null) return null
    const shift = change(current, previous)
    const sameTime = compare.kind === 'sameTime'
    const days = Math.round((compare.range.to - compare.range.from) / 86_400_000)
    return {
      line:
        shift === null ? (
          t(sameTime ? 'figures.noneYesterday' : 'figures.noneBefore', { count: days })
        ) : (
          <Trans
            t={t}
            i18nKey={sameTime ? 'figures.vsYesterday' : 'figures.vsBefore'}
            values={{ change: changePercent(shift), count: days }}
            components={{ b: <b /> }}
          />
        ),
      when: sameTime
        ? t('figures.yesterdayUntil', { time: clockTime(compare.range.to) })
        : rangeText(compare.range.from, compare.range.to),
    }
  }
  const tokenChange = versus(facts.tokens, before?.tokens ?? null)
  const requestChange = versus(
    requests,
    before ? (metricValue(before.parts, 'requests', scope) ?? 0) : null,
  )
  const costChange = cost === null ? null : versus(cost, before ? (before.parts.cost ?? 0) : null)

  const average = perPeriod(facts.tokens)
  const requestAverage = perPeriod(requests)
  return (
    <section className="k-u-figs k-u-span-12" aria-label={t('figures.label')}>
      <Figure
        icon={Activity01Icon}
        label={t('figures.tokens')}
        caption={caption}
        value={used ? <Count value={facts.tokens} /> : null}
        side={
          <MiniBars values={periods.tokens.map((p) => p.total)} labels={labels} format={count} />
        }
        change={tokenChange}
        second={
          average === null ? (
            t('figures.none')
          ) : (
            <Trans
              t={t}
              i18nKey={`figures.tokensPer.${per}`}
              values={{
                value: count(average),
                active: span.activeDays,
                count: span.days,
              }}
              components={{ b: <b /> }}
            />
          )
        }
      />
      <Figure
        icon={ArrowUpRight01Icon}
        label={t(`metrics.${requestKind}`)}
        caption={caption}
        value={used ? <Count value={requests} /> : null}
        side={
          <MiniBars values={periods.requests.map((p) => p.total)} labels={labels} format={count} />
        }
        change={requestChange}
        second={
          requestAverage === null || requests <= 0 ? (
            t('figures.none')
          ) : (
            <Trans
              t={t}
              i18nKey={`figures.requestsPer.${requestKind}.${per}`}
              values={{
                value: count(requestAverage),
                tokens: count(facts.tokens / requests),
              }}
              components={{ b: <b /> }}
            />
          )
        }
      />
      <Figure
        icon={Coins01Icon}
        label={t('figures.cost')}
        caption={caption}
        value={cost === null ? null : usd(cost)}
        side={<MiniBars values={periods.cost.map((p) => p.total)} labels={labels} format={usd} />}
        change={costChange}
        second={
          cost === null ? (
            used ? (
              t('figures.noPrice')
            ) : (
              t('figures.none')
            )
          ) : (
            <>
              {requests > 0 && (
                <Trans
                  t={t}
                  i18nKey={`figures.costPer.${requestKind}`}
                  values={{ value: usd(cost / requests) }}
                  components={{ b: <b /> }}
                />
              )}
              {unpriced > 0 && (
                <>
                  {requests > 0 && ' · '}
                  <Tooltip>
                    <TooltipTrigger render={<span className="k-u-fig__hint" />}>
                      {t('figures.unpricedShort', { tokens: count(unpriced) })}
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72">
                      {t('figures.unpriced', { tokens: count(unpriced) })}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
            </>
          )
        }
      />
      <Figure
        icon={DatabaseIcon}
        label={t('figures.cache')}
        caption={t('figures.mix')}
        value={cache.share === null ? null : percent(cache.share)}
        side={<Composition parts={facts.parts} />}
        first={
          cache.share === null ? null : facts.parts.cacheSaved > 0 ? (
            <Trans
              t={t}
              i18nKey="figures.saved"
              values={{ cost: usd(facts.parts.cacheSaved) }}
              components={{ ok: <span className="k-u-fig__saved" /> }}
            />
          ) : (
            t(cache.read > 0 ? 'figures.savedNone' : 'figures.cacheNone')
          )
        }
        second={
          cache.share === null ? (
            t('figures.none')
          ) : (
            <Trans
              t={t}
              i18nKey="figures.cacheParts"
              values={{
                read: count(facts.parts.cacheRead),
                written: count(facts.parts.cacheWrite),
              }}
              components={{ b: <b /> }}
            />
          )
        }
      />
    </section>
  )
}

/** A line that sets a figure against the period before, and that period for its tooltip. */
type Versus = { line: ReactNode; when: string | null }

/** A figure's card: its name and the bars' period, the value beside the bars, two lines under. */
function Figure({
  icon,
  label,
  caption,
  value,
  side,
  change,
  first,
  second,
}: {
  icon: Parameters<typeof Icon>[0]['icon']
  label: string
  caption: string
  value: ReactNode
  side: ReactNode
  /** The first line when it sets the figure against the period before. */
  change?: Versus | null
  first?: ReactNode
  second: ReactNode
}) {
  return (
    <div className="k-u-card k-u-fig">
      <span className="k-u-fig__top">
        <span className="k-u-fig__name">
          <Icon icon={icon} size={13} />
          {label}
        </span>
        <span className="k-u-fig__cap">{caption}</span>
      </span>
      <span className="k-u-fig__mid">
        <strong className="k-num" data-none={value === null || undefined}>
          {value ?? '—'}
        </strong>
        {side}
      </span>
      <span className="k-u-fig__line">
        {change?.when ? (
          <Tooltip>
            <TooltipTrigger render={<span />}>{change.line}</TooltipTrigger>
            <TooltipContent>{change.when}</TooltipContent>
          </Tooltip>
        ) : change ? (
          change.line
        ) : (
          first
        )}
      </span>
      <span className="k-u-fig__line">{second}</span>
    </div>
  )
}

/** A figure's small bars, the last one darker, each telling its period and amount on hover. */
function MiniBars({
  values,
  labels,
  format,
}: {
  values: readonly number[]
  labels: readonly string[]
  format: (value: number) => string
}) {
  const { t } = useTranslation('usage')
  const [tip, setTip] = useState<{ index: number; at: DOMRect } | null>(null)
  const n = values.length
  if (n === 0) return <span className="k-u-minibars" />
  const max = Math.max(...values)
  const slot = BARS_WIDTH / n
  const gap = n > 40 ? 0.5 : n > 14 ? 1 : 3
  const width = Math.max(1.5, Math.min(slot - gap, 10))
  const bar = (i: number) => {
    const h = values[i]! > 0 && max > 0 ? Math.max(2, (values[i]! / max) * (BARS_HEIGHT - 2)) : 0
    return { x: i * slot + (slot - width) / 2, y: BARS_HEIGHT - h, h }
  }
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = Math.min(
      n - 1,
      Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * n)),
    )
    const { x, y } = bar(index)
    setTip({ index, at: rectIn(event.currentTarget, x, Math.min(y, BARS_HEIGHT - 2), width, 0) })
  }
  return (
    <>
      <svg
        aria-hidden
        className="k-u-minibars"
        width={BARS_WIDTH}
        height={BARS_HEIGHT}
        viewBox={`0 0 ${BARS_WIDTH} ${BARS_HEIGHT}`}
        onPointerMove={point}
        onPointerLeave={() => setTip(null)}
      >
        {values.map((_, i) => {
          const { x, y, h } = bar(i)
          return h > 0 ? (
            <path
              key={i}
              d={topRounded(x, y, width, h, Math.min(2, width / 2))}
              data-last={i === n - 1 || undefined}
              data-on={tip?.index === i || undefined}
            />
          ) : null
        })}
      </svg>
      <ChartTip at={tip?.at ?? null}>
        {tip && (
          <TipRow
            label={labels[tip.index]}
            value={values[tip.index]! > 0 ? format(values[tip.index]!) : t('figures.none')}
          />
        )}
      </ChartTip>
    </>
  )
}

/** What the tokens are made of, as one bar of its kinds, each telling its share on hover. */
function Composition({ parts }: { parts: Parameters<typeof tokenParts>[0] }) {
  const { t } = useTranslation('usage')
  const [tip, setTip] = useState<{ part: TokenPart; at: DOMRect } | null>(null)
  const total = COMPOSITION.reduce((sum, part) => sum + parts[part], 0)
  if (total <= 0) return <span className="k-u-mix" />
  const shares = new Map(tokenParts(parts, total).map((p) => [p.part, p]))
  const shown = COMPOSITION.filter((part) => (shares.get(part)?.tokens ?? 0) > 0)
  return (
    <>
      <span aria-hidden className="k-u-mix" onPointerLeave={() => setTip(null)}>
        {shown.map((part) => (
          <i
            key={part}
            style={{ flexGrow: parts[part] / total, background: PART_COLOR[part] }}
            onPointerEnter={(event) =>
              setTip({ part, at: event.currentTarget.getBoundingClientRect() })
            }
          />
        ))}
      </span>
      <ChartTip at={tip?.at ?? null}>
        {tip && (
          <TipRow
            color={PART_COLOR[tip.part]}
            label={t(`parts.${tip.part}`)}
            value={`${count(parts[tip.part])} · ${sharePercent(parts[tip.part] / total)}`}
          />
        )}
      </ChartTip>
    </>
  )
}
