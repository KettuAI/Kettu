import { describe, expect, it } from 'vitest'
import type { DayUsage } from '@shared/usage'
import {
  addDays,
  dayOf,
  dayStarts,
  dayTotals,
  figures,
  firstDayOfWeek,
  heatLevels,
  heatmapRange,
  modelRows,
  presets,
  projectRows,
  rangeOf,
  trend,
  typedDay,
  typedRange,
  weekStartOf,
} from './model'

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()
const TODAY = day(2026, 10, 22) // a Thursday

function usage(dayIndex: number, agentId: DayUsage['agentId'], output: number): DayUsage {
  return { day: dayIndex, agentId, input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
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
    const byId = Object.fromEntries(presets(TODAY, 1, null).map((p) => [p.id, p]))
    expect(byId.lastWeek).toMatchObject({ from: day(2026, 10, 12), to: day(2026, 10, 18) })
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

  it('draws a bar per day, or per week beyond 92 days, stacked by agent', () => {
    const daily = trend(dayTotals(summary, starts, 'all'), { from: starts[0]!, to: starts[4]! }, 1)
    expect(daily.weekly).toBe(false)
    expect(daily.bars.map((b) => b.total)).toEqual([150, 0, 400, 0])
    expect(daily.bars[0]!.byAgent).toEqual({ 'claude-code': 100, codex: 50 })

    const long = dayStarts({ from: day(2026, 6, 1), to: day(2026, 10, 23) })
    const rows = { days: [usage(0, 'codex', 1), usage(long.length - 2, 'codex', 2)] }
    const weekly = trend(
      dayTotals(rows, long, 'all'),
      { from: long[0]!, to: long[long.length - 1]! },
      1,
    )
    expect(weekly.weekly).toBe(true)
    expect(weekly.bars[0]).toMatchObject({ from: day(2026, 6, 1), to: day(2026, 6, 8), total: 1 })
    expect(weekly.bars.at(-1)).toMatchObject({
      from: day(2026, 10, 19),
      to: day(2026, 10, 23),
      total: 2,
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

describe('breakdowns', () => {
  const parts = { input: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
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
})

describe('typed dates', () => {
  const none = { from: null, to: null }
  const done = { from: true, to: true }
  const typing = { from: false, to: false }

  it('reads YYYY-MM-DD once complete, and nothing else', () => {
    expect(typedDay('2026-10-05', TODAY, false)).toBe(day(2026, 10, 5))
    expect(typedDay(' 2026-10-05 ', TODAY, false)).toBe(day(2026, 10, 5))
    expect(typedDay('2026-10-0', TODAY, false)).toBeNull()
    expect(typedDay('2026-10-0', TODAY, true)).toBe('format')
    expect(typedDay('2026-1-5', TODAY, true)).toBe('format')
    expect(typedDay('2026-02-30', TODAY, false)).toBe('format')
    expect(typedDay('20261005xx', TODAY, false)).toBe('format')
    expect(typedDay('2026-10-23', TODAY, false)).toBe('future')
    expect(typedDay('2026-10-22', TODAY, false)).toBe(TODAY)
  })

  it('keeps the end when a later start is typed, and says the order is wrong', () => {
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: '2026-10-15', to: null }, typing, TODAY)).toEqual({
      range: null,
      error: 'order',
    })
    expect(typedRange(draft, { from: '2026-10-05', to: null }, typing, TODAY)).toEqual({
      range: { from: day(2026, 10, 5), to: day(2026, 10, 10) },
      error: null,
    })
  })

  it('does not take a day after today', () => {
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: null, to: '2026-11-01' }, typing, TODAY)).toEqual({
      range: null,
      error: 'future',
    })
  })

  it('waits for a date being typed, and marks it once the field is left', () => {
    const draft = { from: day(2026, 10, 1), to: null }
    expect(typedRange(draft, { from: null, to: '2026-10-1' }, typing, TODAY)).toEqual({
      range: null,
      error: null,
    })
    expect(typedRange(draft, { from: null, to: '2026-10-1' }, done, TODAY).error).toBe('format')
  })

  it('reads an end alone as that one day, and clearing both as no range', () => {
    expect(typedRange(none, { from: null, to: '2026-10-07' }, typing, TODAY)).toEqual({
      range: { from: day(2026, 10, 7), to: day(2026, 10, 7) },
      error: null,
    })
    const draft = { from: day(2026, 10, 1), to: day(2026, 10, 10) }
    expect(typedRange(draft, { from: '', to: '' }, typing, TODAY)).toEqual({
      range: none,
      error: null,
    })
  })
})
