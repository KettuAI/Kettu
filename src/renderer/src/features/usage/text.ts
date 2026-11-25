import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { count, percent, usd } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import {
  addDays,
  namesYear,
  wholeMonth,
  type MetricKind,
  type TrendBar,
  type TrendUnit,
} from './model'
import { usageAgentName } from './series'

/** "Sep 1 - Oct 22" for [from, to), or one day alone. */
export function useRangeText(): (from: number, to: number) => string {
  const { i18n } = useTranslation('usage')
  return useCallback(
    (from: number, to: number) => {
      const last = addDays(to, -1)
      const sameYear = new Date(from).getFullYear() === new Date(last).getFullYear()
      const thisYear = new Date(last).getFullYear() === new Date().getFullYear()
      const format = new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
        ...(sameYear && thisYear ? {} : { year: 'numeric' }),
      })
      return last === from ? format.format(from) : format.formatRange(from, last)
    },
    [i18n.language],
  )
}

/** "3:00 PM – 4:00 PM" for an hour, with the time zones when `zoned`. */
function useHourText(zoned: boolean): (from: number, to: number) => string {
  const { t, i18n } = useTranslation('usage')
  return useCallback(
    (from: number, to: number) => {
      const time = new Intl.DateTimeFormat(i18n.language, {
        hour: 'numeric',
        minute: '2-digit',
        ...(zoned ? { timeZoneName: 'short' } : {}),
      })
      // Not formatRange, which adds both dates to the day's last hour.
      return t('trend.hour', { from: time.format(from), to: time.format(to) })
    },
    [t, i18n.language, zoned],
  )
}

/** "Tue, Oct 13", with the year when it is not this one. */
export function dayText(day: number): string {
  const thisYear = new Date(day).getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(thisYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(day)
}

/** An amount in the metric, compact, and in words for screen readers. */
export function useMetricText(kind: MetricKind) {
  const { t } = useTranslation('usage')
  return useMemo(() => {
    const short = (value: number) => (kind === 'cost' ? usd(value) : count(value))
    const unit = (value: number): string => {
      const text = count(value)
      if (kind === 'tokens') return t('units.tokens', { value: text })
      if (kind === 'cost') return usd(value)
      return kind === 'requests'
        ? t(value === 1 ? 'units.request' : 'units.requests', { value: text })
        : t(value === 1 ? 'units.turn' : 'units.turns', { value: text })
    }
    const sentence = (date: string, value: number): string =>
      kind === 'tokens'
        ? t('trend.label', { date, tokens: count(value) })
        : kind === 'cost'
          ? t('trend.labelCost', { date, cost: usd(value) })
          : t('trend.labelCount', { date, value: unit(value) })
    const part = (agent: AgentId, value: number): string =>
      t(
        kind === 'tokens'
          ? 'trend.agent'
          : kind === 'cost'
            ? 'trend.agentCost'
            : 'trend.agentCount',
        {
          agent: usageAgentName(agent),
          tokens: count(value),
          cost: usd(value),
          value: unit(value),
        },
      )
    return { short, sentence, part }
  }, [kind, t])
}

/** A share as a whole percentage: "21%". */
export function wholePercent(share: number): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(share)
}

/** A share as `percent` writes it, or "<0.1%" for a sliver that would read as none. */
export function sharePercent(share: number): string {
  const text = percent(share)
  return share > 0 && text === percent(0) ? `<${percent(0.001)}` : text
}

/** A share as a whole percentage, or "<1%" for a sliver that would read as none. */
export function shareWhole(share: number): string {
  const text = wholePercent(share)
  return share > 0 && text === wholePercent(0) ? `<${wholePercent(0.01)}` : text
}

/** A change as a signed whole percentage: "+23%", "−8%". */
export function changePercent(share: number): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }).format(share)
}

/**
 * Each period's labels: short for an axis, "3 PM" or "Nov 2", with the year where the periods
 * cross one; and long for a tooltip, the hour, the day, the week's days or the month.
 */
export function usePeriodText(
  unit: TrendUnit,
  bars: readonly Pick<TrendBar, 'from' | 'to'>[],
  zoned = false,
): { short: string[]; long: string[] } {
  const { i18n } = useTranslation('usage')
  const rangeText = useRangeText()
  const hourText = useHourText(zoned)
  return useMemo(() => {
    const froms = bars.map((bar) => bar.from)
    if (unit === 'hour') {
      const time = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric' })
      return {
        short: froms.map((from) => time.format(from)),
        long: bars.map((bar) => hourText(bar.from, bar.to)),
      }
    }
    const date: Intl.DateTimeFormatOptions =
      unit === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' }
    const plain = new Intl.DateTimeFormat(i18n.language, date)
    const dated = new Intl.DateTimeFormat(i18n.language, { ...date, year: 'numeric' })
    const monthYear = new Intl.DateTimeFormat(i18n.language, { month: 'short', year: 'numeric' })
    return {
      short: froms.map((from, i) =>
        (namesYear(froms, i, i > 0 ? i - 1 : null) ? dated : plain).format(from),
      ),
      long: bars.map((bar) =>
        unit === 'day'
          ? dayText(bar.from)
          : unit === 'month' && wholeMonth(bar)
            ? monthYear.format(bar.from)
            : rangeText(bar.from, bar.to),
      ),
    }
  }, [unit, bars, i18n.language, hourText, rangeText])
}
