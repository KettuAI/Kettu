import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSummary } from '@shared/usage'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const {
  DEFAULT_FILTERS,
  loadUsagePage,
  setUsageFilters,
  usageChanged,
  usagePageShown,
  useUsageStore,
} = await import('./usage')
const { addDays, dayOf } = await import('@renderer/features/usage/model')

const empty: UsageSummary = { days: [], models: [], projects: [], sources: {}, first: null }

describe('usage store', () => {
  beforeEach(() => {
    request.mockReset()
    useUsageStore.setState({ page: null, loading: false, error: null, filters: DEFAULT_FILTERS })
  })

  it('reads the page once more after changes that arrive while it loads', async () => {
    const answers: ((summary: UsageSummary) => void)[] = []
    request.mockImplementation((method: string) =>
      method === 'usage.summary'
        ? new Promise((resolve) => answers.push(resolve))
        : Promise.resolve(method === 'usage.total' ? { total: 0 } : undefined),
    )
    const summaries = () => request.mock.calls.filter(([method]) => method === 'usage.summary')
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
