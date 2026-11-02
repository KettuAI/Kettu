import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DayUsage } from '@shared/usage'
import {
  addDays,
  agentFill,
  agentRows,
  axisLabels,
  barCenters,
  barGap,
  busiest,
  busiestWeekday,
  clocksChange,
  dayOf,
  dayStarts,
  dayTotals,
  figures,
  firstDayOfWeek,
  foldRows,
  fromCache,
  heatLevels,
  heatmapRange,
  hourBars,
  hourLabels,
  hourStarts,
  hoursSoFar,
  ledgerCell,
  legendHidden,
  legendHides,
  modelRows,
  namesYear,
  oneDay,
  planAgents,
  presets,
  projectRows,
  rangeOf,
  resetForm,
  seriesOf,
  shownSeries,
  splitPlans,
  shownTotals,
  streaks,
  tokenParts,
  tokensPerRequest,
  trend,
  typedDay,
  typedRange,
  unpricedTokens,
  usedOutside,
  weekStartOf,
  wholeMonth,
  type BreakdownRow,
  type LegendChoice,
} from './model'

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()
const TODAY = day(2026, 10, 22) // a Thursday
const HOUR = 3_600_000

function usage(
  dayIndex: number,
  agentId: DayUsage['agentId'],
  output: number,
  extra: Partial<
    Pick<DayUsage, 'input' | 'requests' | 'turns' | 'cost' | 'unpricedTokens' | 'cacheSaved'>
  > = {},
): DayUsage {
  return {
    day: dayIndex,
    agentId,
    input: 0,
    output,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    turns: 0,
    cost: null,
    unpricedTokens: 0,
    cacheSaved: 0,
    ...extra,
  }
}

describe('days', () => {
  it('steps through local days, across daylight saving changes', () => {
    expect(dayOf(TODAY + 13 * 3_600_000)).toBe(TODAY)
    expect(addDays(day(2026, 3, 28), 2)).toBe(day(2026, 3, 30))
    expect(addDays(day(2026, 10, 24), 3)).toBe(day(2026, 10, 27))
    expect(dayStarts({ from: day(2026, 3, 28), to: day(2026, 3, 30) })).toEqual([
      day(2026, 3, 28),
      day(2026, 3, 29),
      day(2026, 3, 30),
    ])
  })

  it('starts weeks on the locale’s first day', () => {
    expect(firstDayOfWeek('zh-CN')).toBe(1)
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(weekStartOf(TODAY, 1)).toBe(day(2026, 10, 19))
    expect(weekStartOf(TODAY, 0)).toBe(day(2026, 10, 18))
  })

  it('resolves each range kind to local days', () => {
    expect(rangeOf({ kind: '7' }, TODAY, null)).toEqual({
      from: day(2026, 10, 16),
      to: day(2026, 10, 23),
    })
    expect(rangeOf({ kind: 'all' }, TODAY, day(2025, 10, 20) + 5_000)).toEqual({
      from: day(2025, 10, 20),
      to: day(2026, 10, 23),
    })
    expect(rangeOf({ kind: 'all' }, TODAY, null)).toEqual({ from: TODAY, to: day(2026, 10, 23) })
    expect(
      rangeOf({ kind: 'custom', from: day(2026, 9, 1), to: day(2026, 9, 30) }, TODAY, null),
    ).toEqual({
      from: day(2026, 9, 1),
      to: day(2026, 10, 1),
    })
    const heat = heatmapRange(TODAY, 1)
    expect(heat.to).toBe(day(2026, 10, 23))
    expect(new Date(heat.from).getDay()).toBe(1)
    expect(dayStarts(heat)).toHaveLength(52 * 7 + 4 + 1)
  })

  it('offers presets for the picker', () => {
    const list = presets(TODAY, 1)
    expect(list.map((preset) => preset.id)).toEqual([
      'yesterday',
      'thisWeek',
      'lastWeek',
      'thisMonth',
      'lastMonth',
      'thisYear',
    ])
    const byId = Object.fromEntries(list.map((p) => [p.id, p]))
    expect(byId.yesterday).toMatchObject({ from: day(2026, 10, 21), to: day(2026, 10, 21) })
    expect(byId.thisWeek).toMatchObject({ from: day(2026, 10, 19), to: TODAY })
    expect(byId.lastWeek).toMatchObject({ from: day(2026, 10, 12), to: day(2026, 10, 18) })
    expect(byId.thisMonth).toMatchObject({ from: day(2026, 10, 1), to: TODAY })
    expect(byId.lastMonth).toMatchObject({ from: day(2026, 9, 1), to: day(2026, 9, 30) })
    expect(byId.thisYear).toMatchObject({ from: day(2026, 1, 1), to: TODAY })
  })
})

describe('figures', () => {
  const starts = dayStarts({ from: day(2026, 10, 19), to: day(2026, 10, 23) })
  const summary = {
    days: [usage(0, 'claude-code', 100), usage(0, 'codex', 50), usage(2, 'claude-code', 400)],
  }

  it('sums the range for the chosen agents', () => {
    const all = figures(dayTotals(summary, starts, 'all'), { from: starts[0]!, to: starts[4]! })
    expect(all).toMatchObject({ total: 550, days: 4, activeDays: 2, average: 275 })
    expect(all.peak).toEqual({ day: day(2026, 10, 21), total: 400 })
    const codex = figures(dayTotals(summary, starts, 'codex'), { from: starts[0]!, to: starts[4]! })
    expect(codex).toMatchObject({ total: 50, activeDays: 1 })
    expect(
      figures(dayTotals(summary, starts, 'opencode'), { from: starts[0]!, to: starts[4]! }),
    ).toMatchObject({
      total: 0,
      average: null,
      peak: null,
      cacheShare: null,
    })
  })

  it('counts each metric, requests standing in for turns under Kettu only', () => {
    const metricStarts = dayStarts({ from: day(2026, 10, 19), to: day(2026, 10, 23) })
    const rows = {
      days: [
        usage(0, 'claude-code', 100, { requests: 3, turns: 1, cost: 1.5 }),
        usage(1, 'codex', 50, { requests: 2, turns: 1, cost: 0.25, cacheSaved: 0.75 }),
        usage(2, 'opencode', 400, { requests: 4, turns: 2, unpricedTokens: 400 }),
      ],
    }
    const metricRange = { from: metricStarts[0]!, to: metricStarts[4]! }
    const days = dayTotals(rows, metricStarts, 'all')
    expect(figures(days, metricRange)).toMatchObject({
      total: 550,
      tokens: 550,
      activeDays: 3,
      average: 550 / 3,
      priced: true,
    })
    const requests = figures(days, metricRange, 'requests', 'computer')
    expect(requests).toMatchObject({ total: 9, tokens: 550, average: 3, priced: true })
    expect(requests.peak).toEqual({ day: day(2026, 10, 21), total: 4 })
    expect(figures(days, metricRange, 'requests', 'kettu')).toMatchObject({
      total: 4,
      average: 4 / 3,
    })
    const cost = figures(days, metricRange, 'cost', 'computer')
    expect(cost).toMatchObject({ total: 1.75, tokens: 550, average: 1.75 / 3, priced: true })
    expect(cost.peak).toEqual({ day: day(2026, 10, 19), total: 1.5 })
    expect(cost.parts.unpricedTokens).toBe(400)
    expect(cost.parts.cacheSaved).toBe(0.75)
  })

  it('reads tokens per request and names what no price counts', () => {
    const metricStarts = dayStarts({ from: day(2026, 10, 19), to: day(2026, 10, 23) })
    const rows = {
      days: [
        usage(0, 'claude-code', 100, { requests: 3, cost: 1.5 }),
        usage(1, 'codex', 50, { requests: 2, unpricedTokens: 50 }),
      ],
    }
    const metricRange = { from: metricStarts[0]!, to: metricStarts[4]! }
    const days = dayTotals(rows, metricStarts, 'all')
    const requests = figures(days, metricRange, 'requests', 'computer')
    expect(tokensPerRequest(requests)).toBe(30)
    expect(
      tokensPerRequest(
        figures(dayTotals({ days: [] }, metricStarts, 'all'), metricRange, 'requests'),
      ),
    ).toBeNull()
    const cost = figures(days, metricRange, 'cost', 'computer')
    expect(unpricedTokens(cost)).toBe(50)
    expect(
      unpricedTokens(
        figures(dayTotals({ days: [] }, metricStarts, 'all'), metricRange, 'cost', 'computer'),
      ),
    ).toBeNull()
  })

  it('draws a bar per day, or per week beyond 92 days, stacked by agent', () => {
    const daily = trend(dayTotals(summary, starts, 'all'), { from: starts[0]!, to: starts[4]! }, 1)
    expect(daily.unit).toBe('day')
    expect(daily.bars.map((b) => b.total)).toEqual([150, 0, 400, 0])
    expect(daily.bars[0]!.byAgent).toEqual({ 'claude-code': 100, codex: 50 })

    const long = dayStarts({ from: day(2026, 6, 1), to: day(2026, 10, 23) })
    const rows = { days: [usage(0, 'codex', 1), usage(long.length - 2, 'codex', 2)] }
    const weekly = trend(
      dayTotals(rows, long, 'all'),
      { from: long[0]!, to: long[long.length - 1]! },
      1,
    )
    expect(weekly.unit).toBe('week')
    expect(weekly.bars[0]).toMatchObject({ from: day(2026, 6, 1), to: day(2026, 6, 8), total: 1 })
    expect(weekly.bars.at(-1)).toMatchObject({
      from: day(2026, 10, 19),
      to: day(2026, 10, 23),
      total: 2,
    })
  })

  it('draws a bar per month beyond two years, clipped to the range', () => {
    const twoYears = { from: day(2024, 10, 22), to: day(2026, 10, 23) }
    expect(trend(dayTotals({ days: [] }, dayStarts(twoYears), 'all'), twoYears, 1).unit).toBe(
      'week',
    )
    const range = { from: day(2024, 10, 21), to: day(2026, 10, 23) }
    const starts = dayStarts(range)
    const rows = {
      days: [usage(0, 'codex', 1), usage(10, 'codex', 2), usage(starts.length - 2, 'opencode', 4)],
    }
    const monthly = trend(dayTotals(rows, starts, 'all'), range, 1)
    expect(monthly.unit).toBe('month')
    expect(monthly.bars).toHaveLength(25)
    expect(monthly.bars[0]).toMatchObject({ from: range.from, to: day(2024, 11, 1), total: 3 })
    expect(monthly.bars[1]).toMatchObject({ from: day(2024, 11, 1), to: day(2024, 12, 1) })
    expect(monthly.bars.at(-1)).toMatchObject({
      from: day(2026, 10, 1),
      to: range.to,
      total: 4,
      byAgent: { opencode: 4 },
    })
  })
})

describe('trend series', () => {
  const bars = [
    { from: 0, to: 1, total: 30, byAgent: { codex: 10, 'claude-code': 20 } },
    { from: 1, to: 2, total: 0, byAgent: {} },
    { from: 2, to: 3, total: 25, byAgent: { codex: 25 } },
  ]

  it('stacks the agents with usage in the bars, in the given order', () => {
    expect(seriesOf(bars, ['claude-code', 'codex', 'opencode'])).toEqual(['claude-code', 'codex'])
    expect(seriesOf([], ['claude-code'])).toEqual([])
  })

  it('scales to the series shown and names their busiest bar', () => {
    expect(shownTotals(bars, ['claude-code', 'codex'])).toEqual([30, 0, 25])
    expect(shownTotals(bars, ['codex'])).toEqual([10, 0, 25])
    expect(busiest([10, 0, 25])).toBe(2)
    expect(busiest([4, 4])).toBe(0)
    expect(busiest([0, 0])).toBeNull()
    expect(busiest([])).toBeNull()
  })

  it('hides a series from the legend but always keeps one shown', () => {
    const series = ['claude-code', 'codex', 'opencode'] as const
    expect(legendHidden(series, ['claude-code', 'opencode'], [])).toEqual(['codex'])
    expect(legendHidden(series, ['opencode'], ['codex'])).toEqual(['claude-code', 'codex'])
    // Turning off the last one shown changes nothing.
    expect(legendHidden(series, [], ['claude-code', 'codex'])).toEqual(['claude-code', 'codex'])
    expect(shownSeries(series, ['codex'])).toEqual(['claude-code', 'opencode'])
    // A series hidden before the figures changed leaves the others shown, or all of them.
    expect(shownSeries(['codex'], ['codex'])).toEqual(['codex'])
  })

  it('keeps what the legend hides until a filter changes, even back to an earlier value', () => {
    const legend: LegendChoice = { agent: 2, figures: 5, hidden: ['codex'] }
    expect(legendHides(legend, { agent: 2, figures: 5 })).toEqual(['codex'])
    // Claude Code, then All again: two changes of the agent, though it is All as before.
    expect(legendHides(legend, { agent: 4, figures: 5 })).toEqual([])
    // Figures for another range or source.
    expect(legendHides(legend, { agent: 2, figures: 6 })).toEqual([])
  })
})

describe('axis labels', () => {
  const width = 7
  const measure = (text: string) => text.length * width
  const label = (index: number) => `L${String(index).padStart(2, '0')}`

  it('names the year on the first label and the first of each new year, across one', () => {
    const froms = [day(2025, 11, 1), day(2025, 12, 1), day(2026, 1, 1), day(2026, 2, 1)]
    expect(namesYear(froms, 0, null)).toBe(true)
    expect(namesYear(froms, 1, 0)).toBe(false)
    expect(namesYear(froms, 2, 1)).toBe(true)
    expect(namesYear(froms, 3, 2)).toBe(false)
    // Every other bar labelled: February is the first label of 2026.
    expect(namesYear(froms, 3, 1)).toBe(true)
    expect(namesYear(froms.slice(0, 2), 0, null)).toBe(false)
  })

  it('names a whole month by itself and one the range cuts by its dates', () => {
    expect(wholeMonth({ from: day(2026, 9, 1), to: day(2026, 10, 1) })).toBe(true)
    expect(wholeMonth({ from: day(2025, 12, 1), to: day(2026, 1, 1) })).toBe(true)
    expect(wholeMonth({ from: day(2023, 10, 15), to: day(2023, 11, 1) })).toBe(false)
    expect(wholeMonth({ from: day(2026, 10, 1), to: day(2026, 10, 24) })).toBe(false)
  })

  it('lays bars out as the chart does: at most 48 px, 4 px apart, centred', () => {
    expect(barCenters(3, 300)).toEqual([98, 150, 202])
    const centers = barCenters(30, 600)
    expect(centers[1]! - centers[0]!).toBeCloseTo(484 / 30 + 4)
    expect(centers[0]).toBeCloseTo(484 / 60)
    expect(barCenters(0, 600)).toEqual([])
  })

  it('puts 1 px between more than 45 bars, so they stay wider than the gaps', () => {
    expect(barGap(45)).toBe(4)
    expect(barGap(46)).toBe(1)
    const centers = barCenters(90, 600)
    expect(centers[1]! - centers[0]!).toBeCloseTo(511 / 90 + 1)
    expect(centers[0]).toBeCloseTo(511 / 180)
  })

  it('names every few bars, evenly from the last, without overlap', () => {
    const labels = axisLabels({
      count: 30,
      width: 600,
      anchor: 'end',
      gap: 8,
      text: label,
      measure,
    })
    // 21 px labels and 8 px between them need 29 px: two bars are 40 px apart.
    expect(labels.map((l) => l.index)).toEqual([
      1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29,
    ])
    for (const [i, l] of labels.entries()) {
      expect(l.left).toBeGreaterThanOrEqual(0)
      expect(l.left + measure(l.text)).toBeLessThanOrEqual(600)
      if (i > 0) expect(l.left).toBeGreaterThanOrEqual(labels[i - 1]!.left + 21 + 8)
    }
  })

  it('keeps the labels at the ends inside the row', () => {
    const labels = axisLabels({
      count: 24,
      width: 480,
      anchor: 'start',
      steps: [1, 2, 3, 4, 6, 12],
      gap: 8,
      text: (i) => `${i}:00 AM`,
      measure,
    })
    expect(labels[0]).toMatchObject({ index: 0, left: 0 })
    const last = labels.at(-1)!
    expect(last.left + measure(last.text)).toBeLessThanOrEqual(480)
  })

  it('takes only the steps it is given, from the first bar', () => {
    // 35 px labels need 43 px: three bars of 20 px would do, but hours go by 4.
    const labels = axisLabels({
      count: 24,
      width: 480,
      anchor: 'start',
      steps: [1, 2, 4, 6, 12],
      gap: 8,
      text: (i) => `${String(i).padStart(2, '0')}:00`,
      measure,
    })
    expect(labels.map((l) => l.index)).toEqual([0, 4, 8, 12, 16, 20])
  })

  it('tells each label which one comes before it', () => {
    const calls: [number, number | null][] = []
    const labels = axisLabels({
      count: 10,
      width: 200,
      anchor: 'end',
      gap: 8,
      text: (index, previous) => {
        calls.push([index, previous])
        return label(index)
      },
      measure,
    })
    expect(labels.map((l) => l.index)).toEqual([1, 3, 5, 7, 9])
    expect(calls.slice(-5)).toEqual([
      [1, null],
      [3, 1],
      [5, 3],
      [7, 5],
      [9, 7],
    ])
  })

  it('falls back to one label when no step fits, and to none without bars', () => {
    expect(
      axisLabels({ count: 10, width: 30, anchor: 'end', gap: 8, text: label, measure }),
    ).toEqual([{ index: 9, text: 'L09', left: 9 }])
    expect(
      axisLabels({
        count: 6,
        width: 60,
        anchor: 'start',
        steps: [1, 2],
        gap: 8,
        text: label,
        measure,
      }),
    ).toEqual([{ index: 0, text: 'L00', left: 0 }])
    expect(
      axisLabels({ count: 0, width: 600, anchor: 'end', gap: 8, text: label, measure }),
    ).toEqual([])
  })
})

describe('hours', () => {
  it('shows one day, from the preset or picked, by the hour', () => {
    const range = rangeOf({ kind: '1' }, TODAY, null)
    expect(range).toEqual({ from: TODAY, to: day(2026, 10, 23) })
    expect(oneDay(range)).toBe(true)
    const yesterday = addDays(TODAY, -1)
    expect(oneDay(rangeOf({ kind: 'custom', from: yesterday, to: yesterday }, TODAY, null))).toBe(
      true,
    )
    expect(oneDay(rangeOf({ kind: 'custom', from: yesterday, to: TODAY }, TODAY, null))).toBe(false)
    expect(oneDay(rangeOf({ kind: 'all' }, TODAY, TODAY + 9 * HOUR))).toBe(true)
    expect(oneDay(rangeOf({ kind: '7' }, TODAY, null))).toBe(false)
  })

  it('draws a bar per hour and counts the hours begun so far', () => {
    const range = rangeOf({ kind: '1' }, TODAY, null)
    const starts = hourStarts(range)
    expect(starts).toHaveLength(25)
    expect(starts[13]).toBe(TODAY + 13 * HOUR)
    const summary = {
      days: [usage(9, 'codex', 30), usage(9, 'claude-code', 10), usage(2, 'codex', 5)],
    }
    const hours = dayTotals(summary, starts, 'all')
    const bars = hourBars(hours, starts)
    expect(bars).toHaveLength(24)
    expect(bars[9]).toEqual({
      from: TODAY + 9 * HOUR,
      to: TODAY + 10 * HOUR,
      total: 40,
      byAgent: { codex: 30, 'claude-code': 10 },
    })

    const soFar = hoursSoFar(starts, TODAY + 10.5 * HOUR)
    expect(soFar).toEqual({ from: TODAY, to: TODAY + 11 * HOUR })
    expect(figures(hours, soFar)).toMatchObject({
      total: 45,
      days: 11,
      activeDays: 2,
      average: 22.5,
      peak: { day: TODAY + 9 * HOUR, total: 40 },
    })
    expect(hoursSoFar(starts, day(2026, 10, 24))).toEqual(range)
  })

  describe('when the clocks change', () => {
    // Restored by name: on Windows, removing TZ again leaves the stubbed zone in place.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    afterEach(() => {
      vi.stubEnv('TZ', zone)
    })
    const hoursOf = (date: number) => hourStarts({ from: date, to: addDays(date, 1) })
    // The host takes only ascending boundaries on quarter hours.
    const valid = (starts: number[]) =>
      starts.every((start, i) => start % 900_000 === 0 && (i === 0 || start > starts[i - 1]!))

    it('has 23 hours on the day they spring forward and 25 on the day they fall back', () => {
      vi.stubEnv('TZ', 'America/New_York')
      for (const [date, hours] of [
        [day(2026, 3, 8), 23],
        [day(2026, 11, 1), 25],
      ] as const) {
        const starts = hoursOf(date)
        expect(starts).toHaveLength(hours + 1)
        expect(valid(starts)).toBe(true)
        for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(HOUR)
        expect(clocksChange(starts)).toBe(true)
      }
      expect(clocksChange(hoursOf(day(2026, 11, 2)))).toBe(false)
    })

    it('starts on the local hour again after a change of half an hour', () => {
      vi.stubEnv('TZ', 'Australia/Lord_Howe')
      for (const date of [day(2026, 4, 5), day(2026, 10, 4)]) {
        const starts = hoursOf(date)
        expect(valid(starts)).toBe(true)
        // Only the half hour the clocks move by starts off the hour.
        const minutes = starts.slice(0, -1).map((start) => new Date(start).getMinutes())
        expect(minutes.filter((m) => m !== 0)).toEqual([30])
        expect(starts.slice(1).every((start, i) => start - starts[i]! <= HOUR)).toBe(true)
      }
    })

    it('labels the hours by the clock, every few from midnight', () => {
      vi.stubEnv('TZ', 'America/New_York')
      for (const date of [day(2026, 3, 8), day(2026, 11, 1), day(2026, 11, 2)]) {
        const starts = hoursOf(date).slice(0, -1)
        const hour = (i: number) => new Date(starts[i]!).getHours()
        const present = [...new Set(starts.map((start) => new Date(start).getHours()))]
        // The hour the clocks repeat is labelled once, the one they skip not at all.
        expect(hourLabels(starts, 1).map(hour)).toEqual(present)
        const labels = axisLabels({
          count: starts.length,
          width: 380,
          anchor: 'start',
          steps: [1, 2, 3, 4, 6, 12],
          pick: (step) => hourLabels(starts, step),
          gap: 8,
          text: (i) => `${hour(i)}:00`,
          measure: (text) => text.length * 7,
        })
        const hours = labels.map((l) => hour(l.index))
        const step = hours[1]! - hours[0]!
        expect(hours).toEqual(present.filter((h) => h % step === 0))
      }
    })
  })
})

describe('heatLevels', () => {
  it('shades by quartile among the days with usage', () => {
    expect(heatLevels([0, 1, 2, 3, 4, 1000])).toEqual([0, 1, 1, 2, 3, 4])
    expect(heatLevels([5, 5, 5])).toEqual([1, 1, 1])
    expect(heatLevels([0, 0])).toEqual([0, 0])
  })
})

describe('usedOutside', () => {
  const days = [TODAY, addDays(TODAY, 1), addDays(TODAY, 2)]
  const range = { from: addDays(TODAY, 1), to: addDays(TODAY, 3) }

  it('tells when a day outside the range has usage', () => {
    expect(usedOutside(days, [5, 0, 0], range)).toBe(true)
  })

  it('ignores empty days outside the range and usage inside it', () => {
    expect(usedOutside(days, [0, 7, 9], range)).toBe(false)
  })
})

describe('tokenParts', () => {
  const parts = { input: 30, output: 20, reasoning: 0, cacheRead: 40, cacheWrite: 10 }

  it('gives each type its tokens and share, in order', () => {
    expect(tokenParts(parts, 100)).toEqual([
      { part: 'input', tokens: 30, share: 0.3 },
      { part: 'output', tokens: 20, share: 0.2 },
      { part: 'cacheRead', tokens: 40, share: 0.4 },
      { part: 'cacheWrite', tokens: 10, share: 0.1 },
    ])
  })

  it('keeps reasoning where an agent reports it', () => {
    expect(tokenParts({ ...parts, reasoning: 5 }, 105).map((p) => p.part)).toEqual([
      'input',
      'output',
      'reasoning',
      'cacheRead',
      'cacheWrite',
    ])
  })

  it('has no shares without tokens', () => {
    expect(tokenParts({ ...parts, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0)).toEqual([
      { part: 'input', tokens: 0, share: null },
      { part: 'output', tokens: 0, share: null },
      { part: 'cacheRead', tokens: 0, share: null },
      { part: 'cacheWrite', tokens: 0, share: null },
    ])
  })
})

describe('figure cells', () => {
  it('lines the four figures two to a row', () => {
    expect(Array.from({ length: 4 }, (_, i) => ledgerCell(i))).toEqual([
      { top: false, left: false },
      { top: false, left: true },
      { top: true, left: false },
      { top: true, left: true },
    ])
  })
})

describe('activity stats', () => {
  // Oct 10 to Oct 22, today, a Thursday.
  const range = { from: day(2026, 10, 10), to: day(2026, 10, 23) }
  const starts = dayStarts(range)
  const used = (indices: number[]) =>
    dayTotals({ days: indices.map((i) => usage(i, 'codex', 10)) }, starts, 'all')

  it('finds the longest run of days with usage, the first of equals', () => {
    const days = used([0, 1, 2, 4, 5, 6, 7, 9, 10, 11])
    expect(streaks(days, range, TODAY).longest).toEqual({
      days: 4,
      from: day(2026, 10, 14),
      to: day(2026, 10, 17),
    })
    expect(streaks(used([0, 1, 2, 3, 5, 6, 7, 8]), range, TODAY).longest).toEqual({
      days: 4,
      from: day(2026, 10, 10),
      to: day(2026, 10, 13),
    })
    // Only the days in the range count.
    expect(streaks(days, { from: day(2026, 10, 15), to: range.to }, TODAY).longest).toEqual({
      days: 3,
      from: day(2026, 10, 15),
      to: day(2026, 10, 17),
    })
  })

  it('counts the current streak to the last day, or to yesterday while today has none', () => {
    expect(streaks(used([9, 10, 11]), range, TODAY).current).toBe(3)
    expect(streaks(used([9, 10, 11, 12]), range, TODAY).current).toBe(4)
    expect(streaks(used([9, 10]), range, TODAY).current).toBe(0)
    // A range that ends before today has no grace for its last day.
    const earlier = { from: range.from, to: day(2026, 10, 22) }
    expect(streaks(used([9, 10]), earlier, TODAY).current).toBe(0)
    expect(streaks(used([9, 10, 11]), earlier, TODAY).current).toBe(3)
  })

  it('has no streaks without usage', () => {
    expect(streaks(used([]), range, TODAY)).toEqual({ current: 0, longest: null })
  })

  it('finds the busiest weekday in the metric, the first from the week start among equals', () => {
    // Oct 12 and 19 are Mondays, Oct 14 a Wednesday, Oct 20 a Tuesday.
    const days = dayTotals(
      {
        days: [
          usage(2, 'codex', 30, { requests: 1 }),
          usage(9, 'codex', 100, { requests: 1 }),
          usage(10, 'codex', 50, { requests: 1 }),
          usage(4, 'claude-code', 130, { requests: 4 }),
        ],
      },
      starts,
      'all',
    )
    expect(busiestWeekday(days, range, 1)).toEqual({ weekday: 1, share: 130 / 310 })
    expect(busiestWeekday(days, range, 3)).toEqual({ weekday: 3, share: 130 / 310 })
    expect(busiestWeekday(days, range, 1, 'requests')).toEqual({ weekday: 3, share: 4 / 7 })
    expect(busiestWeekday(days, { from: day(2026, 10, 19), to: range.to }, 1)).toEqual({
      weekday: 1,
      share: 100 / 150,
    })
    expect(busiestWeekday(used([]), range, 1)).toBeNull()
  })
})

describe('fromCache', () => {
  const parts = { input: 10, output: 5, reasoning: 0, cacheRead: 981, cacheWrite: 4 }

  it('gives the cache reads, the rest, and their share of every 100 tokens', () => {
    expect(fromCache(parts)).toEqual({ read: 981, other: 19, share: 0.981, perHundred: 98 })
  })

  it('never rounds to all or none while that is not so', () => {
    expect(
      fromCache({ ...parts, input: 1, output: 0, cacheRead: 999, cacheWrite: 0 }),
    ).toMatchObject({ perHundred: 99 })
    expect(
      fromCache({ ...parts, input: 999, output: 0, cacheRead: 1, cacheWrite: 0 }),
    ).toMatchObject({ perHundred: 1 })
    expect(fromCache({ ...parts, cacheRead: 0 })).toMatchObject({
      read: 0,
      share: 0,
      perHundred: 0,
    })
    expect(fromCache({ ...parts, input: 0, output: 0, cacheWrite: 0 })).toMatchObject({
      share: 1,
      perHundred: 100,
    })
  })

  it('has no share without tokens', () => {
    expect(fromCache({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
      read: 0,
      other: 0,
      share: null,
      perHundred: null,
    })
  })
})

describe('plan limits', () => {
  it('lists the agents with limits and the others with usage, in their order', () => {
    const agents = [
      { id: 'claude-code' as const, limits: [{}] },
      { id: 'codex' as const, limits: [] },
      { id: 'opencode' as const, limits: [] },
      { id: 'fake-agent' as const, limits: [{}] },
    ]
    expect(planAgents(agents, ['opencode']).map((a) => a.id)).toEqual([
      'claude-code',
      'opencode',
      'fake-agent',
    ])
    expect(planAgents(agents, [])).toHaveLength(2)
  })

  it('gives each account that reports limits a row, and joins the others in a line', () => {
    const reports = { reports: true }
    const silent = { reports: false }
    const agents = [
      { id: 'claude-code', limits: [{}], capabilities: reports },
      { id: 'codex', limits: [], capabilities: reports },
      { id: 'opencode', limits: [], capabilities: silent },
      { id: 'pi', limits: [], capabilities: silent },
    ]
    const { rows, unreported } = splitPlans(agents)
    expect(rows.map((a) => a.id)).toEqual(['claude-code', 'codex'])
    expect(unreported.map((a) => a.id)).toEqual(['opencode', 'pi'])
  })

  it('counts down to a reset within a day, and names the time of one further off', () => {
    const now = TODAY + 9 * HOUR
    expect(resetForm(now + 2 * HOUR, now)).toBe('in')
    expect(resetForm(now + 24 * HOUR - 1, now)).toBe('in')
    expect(resetForm(now + 24 * HOUR, now)).toBe('at')
    expect(resetForm(now + 3 * 24 * HOUR, now)).toBe('at')
    // A window that has already reset waits for the next read; its time is all there is to say.
    expect(resetForm(now - HOUR, now)).toBe('at')
  })
})

describe('breakdowns', () => {
  const parts = {
    input: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    turns: 0,
    cost: null,
    unpricedTokens: 0,
    cacheSaved: 0,
  }
  it('ranks models across agents and projects by folder', () => {
    const models = modelRows(
      {
        models: [
          { agentId: 'claude-code', model: 'a', output: 5, ...parts },
          { agentId: 'codex', model: 'a', output: 5, ...parts },
          { agentId: 'codex', model: 'b', output: 3, ...parts },
        ],
      },
      'all',
    )
    expect(models.map((m) => [m.name, m.total])).toEqual([
      ['a', 10],
      ['b', 3],
    ])
    const projects = projectRows(
      {
        projects: [
          { agentId: 'codex', project: '/p/kite', scratch: false, output: 4, ...parts },
          { agentId: 'codex', project: '/data/scratch/x', scratch: true, output: 2, ...parts },
          { agentId: 'codex', project: null, scratch: false, output: 3, ...parts },
        ],
      },
      'codex',
      (path) => path.split('/').pop()!,
    )
    expect(projects.map((p) => [p.name, p.total])).toEqual([
      [null, 5],
      ['kite', 4],
    ])
  })

  it('ranks and values the breakdowns in the metric, an unpriced model last', () => {
    const rows = {
      models: [
        {
          agentId: 'claude-code' as const,
          model: 'a',
          output: 5,
          ...parts,
          requests: 2,
          cost: 1.25,
        },
        {
          agentId: 'codex' as const,
          model: 'b',
          output: 3,
          ...parts,
          requests: 1,
          unpricedTokens: 3,
        },
      ],
    }
    const byCost = modelRows(rows, 'all', 'cost', 'computer')
    expect(byCost.map((row) => [row.name, row.value, row.total])).toEqual([
      ['a', 1.25, 5],
      ['b', null, 3],
    ])
    const byRequests = modelRows(rows, 'all', 'requests', 'computer')
    expect(byRequests.map((row) => [row.name, row.value])).toEqual([
      ['a', 2],
      ['b', 1],
    ])
  })

  it('names the agents in each row, the most tokens first, and groups by agent', () => {
    const rows = {
      models: [
        { agentId: 'claude-code' as const, model: 'a', output: 5, ...parts },
        { agentId: 'codex' as const, model: 'a', output: 8, ...parts },
        { agentId: 'codex' as const, model: 'b', output: 3, ...parts },
      ],
    }
    expect(modelRows(rows, 'all').map((row) => [row.name, row.agents])).toEqual([
      ['a', ['codex', 'claude-code']],
      ['b', ['codex']],
    ])
    expect(agentRows(rows, 'all').map((row) => [row.key, row.agents, row.total])).toEqual([
      ['codex', ['codex'], 11],
      ['claude-code', ['claude-code'], 5],
    ])
    expect(agentRows(rows, 'claude-code').map((row) => row.key)).toEqual(['claude-code'])
  })

  it('folds the rows past the first five into one, unless only one is left', () => {
    const row = (key: string, value: number | null, total = 10): BreakdownRow => ({
      key,
      name: key,
      path: null,
      agents: ['codex'],
      total,
      value,
    })
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => row(key, 1))
    expect(foldRows(six)).toEqual({ rows: six, rest: null })
    const eight = [...six, row('g', 2, 20), row('h', null, 5)]
    expect(foldRows(eight)).toEqual({
      rows: eight.slice(0, 5),
      rest: { count: 3, total: 35, value: 3 },
    })
    expect(foldRows([...six, row('g', null)]).rest).toEqual({ count: 2, total: 20, value: 1 })
    const unpriced = [...six.slice(0, 5), row('f', null), row('g', null)]
    expect(foldRows(unpriced).rest).toEqual({ count: 2, total: 20, value: null })
  })
})

describe('typed dates', () => {
  const none = { from: null, to: null }
  const done = { from: true, to: true }
  const typing = { from: false, to: false }
  const EARLIEST = day(2025, 6, 1)

  it('reads YYYY-MM-DD once complete, and nothing else', () => {
    expect(typedDay('2026-10-05', TODAY, false, EARLIEST)).toBe(day(2026, 10, 5))
    expect(typedDay(' 2026-10-05 ', TODAY, false, EARLIEST)).toBe(day(2026, 10, 5))
    expect(typedDay('2026-10-0', TODAY, false, EARLIEST)).toBeNull()
    expect(typedDay('2026-10-0', TODAY, true, EARLIEST)).toBe('format')
    expect(typedDay('2026-1-5', TODAY, true, EARLIEST)).toBe('format')
    expect(typedDay('2026-02-30', TODAY, false, EARLIEST)).toBe('format')
    expect(typedDay('20261005xx', TODAY, false, EARLIEST)).toBe('format')
    expect(typedDay('2026-10-23', TODAY, false, EARLIEST)).toBe('future')
    expect(typedDay('2026-10-22', TODAY, false, EARLIEST)).toBe(TODAY)
  })

  it('does not take a day before the calendar starts, and takes its first day', () => {
    expect(typedDay('1975-01-01', TODAY, true, EARLIEST)).toBe('early')
    expect(typedDay('2025-06-01', TODAY, true, EARLIEST)).toBe(EARLIEST)
  })

  it('keeps the end when a later start is typed, and says the order is wrong', () => {
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: '2026-10-15', to: null }, typing, TODAY, EARLIEST)).toEqual({
      range: null,
      error: 'order',
    })
    expect(typedRange(draft, { from: '2026-10-05', to: null }, typing, TODAY, EARLIEST)).toEqual({
      range: { from: day(2026, 10, 5), to: day(2026, 10, 10) },
      error: null,
    })
  })

  it('does not take a day after today', () => {
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: null, to: '2026-11-01' }, typing, TODAY, EARLIEST)).toEqual({
      range: null,
      error: 'future',
    })
  })

  it('does not take a range that starts or ends before the calendar', () => {
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: '1975-01-01', to: null }, typing, TODAY, EARLIEST)).toEqual({
      range: null,
      error: 'early',
    })
    expect(typedRange(none, { from: null, to: '1975-01-01' }, typing, TODAY, EARLIEST)).toEqual({
      range: null,
      error: 'early',
    })
  })

  it('waits for a date being typed, and marks it once the field is left', () => {
    const draft = { from: day(2026, 10, 1), to: null }
    expect(typedRange(draft, { from: null, to: '2026-10-1' }, typing, TODAY, EARLIEST)).toEqual({
      range: null,
      error: null,
    })
    expect(typedRange(draft, { from: null, to: '2026-10-1' }, done, TODAY, EARLIEST).error).toBe(
      'format',
    )
  })

  it('reads an end alone as that one day, and clearing both as no range', () => {
    expect(typedRange(none, { from: null, to: '2026-10-07' }, typing, TODAY, EARLIEST)).toEqual({
      range: { from: day(2026, 10, 7), to: day(2026, 10, 7) },
      error: null,
    })
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: '', to: '' }, typing, TODAY, EARLIEST)).toEqual({
      range: none,
      error: null,
    })
  })
})

describe('agentFill', () => {
  it('gives an agent with no series color of its own the shared one', () => {
    expect(agentFill('claude-code')).toBe('bg-agent-claude-code')
    expect(agentFill('poolside')).toBe('bg-agent-other')
  })
})
