import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageSummary } from '@shared/usage'

const request = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request } } })

const { usageChanged, usagePageShown, useUsageStore } = await import('./usage')

const empty: UsageSummary = { days: [], models: [], projects: [], sources: {}, first: null }

describe('usage store', () => {
  beforeEach(() => {
    request.mockReset()
    useUsageStore.setState({ page: null, loading: false, error: null })
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
})
