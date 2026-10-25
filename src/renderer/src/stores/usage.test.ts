import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSummary } from '@shared/usage'
import type { LegendChoice } from '@renderer/features/usage/model'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const {
  DEFAULT_FILTERS,
  loadUsagePage,
  setUsageFilters,
  usageChanged,
  usageDayTurned,
  usagePageShown,
  useUsageStore,
} = await import('./usage')
const { addDays, dayOf, hourStarts, legendHides } = await import('@renderer/features/usage/model')

// A one-day range's hour read has at most 26 boundaries; the day read holds the 53 weeks.
const hourRead = (params: { dayStarts: number[] }) => params.dayStarts.length <= 26

const empty: UsageSummary = {
  days: [],
  models: [],
  projects: [],
  sources: {},
  first: null,
  agents: [],
  pricesAsOf: '2026-10-25',
}

describe('usage store', () => {
  beforeEach(() => {
    request.mockReset()
    useUsageStore.setState({ page: null, loading: false, error: null, filters: DEFAULT_FILTERS })
  })

  it('reads the page once more after changes that arrive while it loads', async () => {
    const answers: ((summary: UsageSummary) => void)[] = []
    // The day sums wait for the test; the hours of All time's one day answer at once.
    request.mockImplementation((method: string, params: { dayStarts: number[] }) =>
      method !== 'usage.summary'
        ? Promise.resolve(method === 'usage.total' ? { total: 0 } : undefined)
        : hourRead(params)
          ? Promise.resolve(empty)
          : new Promise((resolve) => answers.push(resolve)),
    )
    const summaries = () =>
      request.mock.calls.filter(
        ([method, params]) => method === 'usage.summary' && !hourRead(params),
      )
    usagePageShown(true)
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    // A scan sends a change notice every 200 ms; reading for each would pile up in the worker.
    for (let i = 0; i < 5; i++) usageChanged()
    expect(summaries()).toHaveLength(1)
    answers[0]!(empty)
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    answers[1]!(empty)
    await vi.waitFor(() => expect(useUsageStore.getState().loading).toBe(false))
    expect(summaries()).toHaveLength(2)
    expect(useUsageStore.getState().page?.summary).toEqual(empty)
    usagePageShown(false)
  })

  it('reads all time from the first day with usage, also when it is inside the heatmap', async () => {
    const today = dayOf(Date.now())
    const first = addDays(today, -40) + 3_600_000
    request.mockImplementation((method: string) =>
      Promise.resolve(method === 'usage.summary' ? { ...empty, first } : undefined),
    )
    await loadUsagePage()
    const page = useUsageStore.getState().page!
    expect(page.range).toEqual({ from: addDays(today, -40), to: addDays(today, 1) })
    const asked = request.mock.calls.filter(([method]) => method === 'usage.summary')
    expect(asked.at(-1)![1]).toMatchObject({ from: addDays(today, -40) })
    // The first pass took all time for today alone, until the answer named the first day.
    expect(asked.filter(([, params]) => hourRead(params))).toHaveLength(0)
  })

  it('reads all time again from the new first day when the scope changes', async () => {
    const today = dayOf(Date.now())
    const firsts = { computer: addDays(today, -10), overbench: addDays(today, -2) }
    request.mockImplementation((method: string, params: { scope: 'computer' | 'overbench' }) =>
      Promise.resolve(
        method === 'usage.summary' ? { ...empty, first: firsts[params.scope] } : undefined,
      ),
    )
    setUsageFilters({ scope: 'overbench' })
    await vi.waitFor(() => expect(useUsageStore.getState().page?.range.from).toBe(firsts.overbench))
    setUsageFilters({ scope: 'computer' })
    await vi.waitFor(() => expect(useUsageStore.getState().page?.range.from).toBe(firsts.computer))
  })

  it('reads the hours of a one-day range as well, for its trend', async () => {
    const today = dayOf(Date.now())
    const hours = { ...empty, first: today }
    request.mockImplementation((method: string, params: { dayStarts: number[] }) =>
      Promise.resolve(
        method === 'usage.summary' ? (params.dayStarts.length > 26 ? empty : hours) : undefined,
      ),
    )
    setUsageFilters({ range: { kind: '1' } })
    await vi.waitFor(() => expect(useUsageStore.getState().page).not.toBeNull())
    const page = useUsageStore.getState().page!
    const starts = hourStarts({ from: today, to: addDays(today, 1) })
    expect(page.hours).toEqual({ starts, summary: hours })
    expect(page.summary).toEqual(empty)
    const asked = request.mock.calls.filter(([method]) => method === 'usage.summary')
    expect(asked.map(([, params]) => params.dayStarts.length)).toContain(starts.length)

    setUsageFilters({ range: { kind: '7' } })
    await vi.waitFor(() => expect(useUsageStore.getState().page?.range.from).not.toBe(today))
    expect(useUsageStore.getState().page?.hours).toBeNull()
  })

  it('reads the page again once the day turns while it shows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const evening = new Date(2026, 9, 22, 23, 59).getTime()
    const tomorrow = addDays(dayOf(evening), 1)
    try {
      vi.setSystemTime(evening)
      request.mockImplementation((method: string) =>
        Promise.resolve(method === 'usage.summary' ? empty : undefined),
      )
      useUsageStore.setState({ filters: { ...DEFAULT_FILTERS, range: { kind: '1' } } })
      usagePageShown(true)
      await vi.waitFor(() => expect(useUsageStore.getState().loading).toBe(false))
      expect(useUsageStore.getState().page?.today).toBe(dayOf(evening))
      const reads = () => request.mock.calls.filter(([method]) => method === 'usage.summary')
      const before = reads().length
      usageDayTurned(dayOf(evening))
      expect(reads()).toHaveLength(before)

      vi.setSystemTime(evening + 2 * 60_000)
      usageDayTurned(dayOf(Date.now()))
      await vi.waitFor(() => expect(useUsageStore.getState().page?.today).toBe(tomorrow))
      expect(useUsageStore.getState().page?.hours?.starts[0]).toBe(tomorrow)
    } finally {
      usagePageShown(false)
      vi.useRealTimers()
    }
  })

  it('shows every series again after any filter change, round trips included', async () => {
    const answers: (() => void)[] = []
    request.mockImplementation((method: string) =>
      method === 'usage.summary'
        ? new Promise((resolve) => answers.push(() => resolve(empty)))
        : Promise.resolve(undefined),
    )
    const arrive = async () => {
      for (const answer of answers.splice(0)) answer()
      await vi.waitFor(() => expect(useUsageStore.getState().loading).toBe(false))
    }
    // What the trend card draws: the agent filter at once, the range and source of its figures.
    const drawn = () => {
      const { generations, page } = useUsageStore.getState()
      return { agent: generations.agent, figures: page!.generation }
    }
    const hideCodex = (): LegendChoice => ({ ...drawn(), hidden: ['codex'] })
    useUsageStore.setState({ filters: { ...DEFAULT_FILTERS, range: { kind: '30' } } })
    void loadUsagePage()
    await arrive()

    // Hidden on All, then Claude Code and All again.
    let legend = hideCodex()
    setUsageFilters({ agent: 'claude-code' })
    setUsageFilters({ agent: 'all' })
    expect(legendHides(legend, drawn())).toEqual([])

    // The chart still drawn keeps its series until the figures for the new source arrive.
    legend = hideCodex()
    setUsageFilters({ scope: 'overbench' })
    expect(legendHides(legend, drawn())).toEqual(['codex'])
    await arrive()
    setUsageFilters({ scope: 'computer' })
    await arrive()
    expect(legendHides(legend, drawn())).toEqual([])

    // Back again before the other source's figures arrive is still a change.
    legend = hideCodex()
    setUsageFilters({ scope: 'overbench' })
    setUsageFilters({ scope: 'computer' })
    expect(legendHides(legend, drawn())).toEqual(['codex'])
    await arrive()
    expect(legendHides(legend, drawn())).toEqual([])

    // Reading the same filters again, as a sync does, is not a change.
    legend = hideCodex()
    void loadUsagePage()
    await arrive()
    expect(legendHides(legend, drawn())).toEqual(['codex'])
  })

  it('keeps the last 53 weeks for the heatmap whatever the range', async () => {
    const today = dayOf(Date.now())
    request.mockImplementation((method: string) =>
      Promise.resolve(method === 'usage.summary' ? empty : undefined),
    )
    const from = new Date(2024, 0, 1).getTime()
    setUsageFilters({ range: { kind: 'custom', from, to: new Date(2024, 0, 31).getTime() } })
    await vi.waitFor(() => expect(useUsageStore.getState().page).not.toBeNull())
    const { starts, range } = useUsageStore.getState().page!
    expect(range.from).toBe(from)
    expect(starts[0]).toBe(from)
    expect(starts.at(-1)).toBe(addDays(today, 1))
  })
})
