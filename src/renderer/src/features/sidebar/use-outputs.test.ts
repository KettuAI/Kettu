import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOutputs, SessionSummary } from '@shared/agent-host'

const hostMock = vi.fn<(...args: unknown[]) => Promise<SessionOutputs>>()

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
}))

import { clearSessionOutputsCache, prefetchOutputs, useOutputs } from './use-outputs'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    agentId: 'claude-code',
    projectPath: '/work/kettu',
    scratch: false,
    title: 'Test session',
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 100,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...overrides,
  }
}

function makeOutputs(overrides: Partial<SessionOutputs> = {}): SessionOutputs {
  return {
    artifacts: [{ id: 'art_1', title: 'Spec' }],
    references: ['https://github.com/KettuAI/Kettu/pull/3065'],
    reply: 'Done.',
    turnMs: 1200,
    ...overrides,
  }
}

function Probe({ summary }: { summary: SessionSummary }) {
  const outputs = useOutputs(summary)
  return createElement('div', {
    'data-ready': outputs ? 'yes' : 'no',
    'data-reply': outputs?.reply ?? '',
  })
}

describe('use-outputs prefetchOutputs and caching', () => {
  beforeEach(() => {
    hostMock.mockReset()
    clearSessionOutputsCache()
  })

  afterEach(() => {
    clearSessionOutputsCache()
  })

  it('caches prefetched outputs per id:updatedAt and makes them immediately available to useOutputs', async () => {
    const sample = makeOutputs()
    hostMock.mockResolvedValueOnce(sample)
    const summary = makeSummary({ id: 'sess-1', updatedAt: 100 })

    // Before prefetch, initial synchronous render is still loading.
    expect(renderToStaticMarkup(createElement(Probe, { summary }))).toContain('data-ready="no"')

    const first = await prefetchOutputs(summary)
    expect(first).toEqual(sample)
    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.outputs', { sessionId: 'sess-1' })

    // Calling prefetchOutputs again for the same version hits the cache without another host call.
    const second = await prefetchOutputs(summary)
    expect(second).toBe(sample)
    expect(hostMock).toHaveBeenCalledTimes(1)

    // Once prefetched, useOutputs resolves synchronously on the first render (no height jump).
    const html = renderToStaticMarkup(createElement(Probe, { summary }))
    expect(html).toContain('data-ready="yes"')
    expect(html).toContain('data-reply="Done."')
  })

  it('deduplicates concurrent in-flight requests for the same id:updatedAt', async () => {
    let resolveFetch!: (value: SessionOutputs) => void
    hostMock.mockImplementationOnce(
      () =>
        new Promise<SessionOutputs>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const summary = makeSummary({ id: 'sess-2', updatedAt: 200 })

    const p1 = prefetchOutputs(summary)
    const p2 = prefetchOutputs(summary)
    expect(p1).toBe(p2)
    expect(hostMock).toHaveBeenCalledTimes(1)

    const sample = makeOutputs({ reply: 'Deduped' })
    resolveFetch(sample)
    expect(await p1).toEqual(sample)
    expect(await p2).toEqual(sample)
  })

  it('refetches when updatedAt advances and ignores stale out-of-order responses', async () => {
    let resolveStale!: (value: SessionOutputs) => void
    let resolveFresh!: (value: SessionOutputs) => void
    hostMock
      .mockImplementationOnce(
        () =>
          new Promise<SessionOutputs>((resolve) => {
            resolveStale = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<SessionOutputs>((resolve) => {
            resolveFresh = resolve
          }),
      )

    const staleSummary = makeSummary({ id: 'sess-3', updatedAt: 100 })
    const freshSummary = makeSummary({ id: 'sess-3', updatedAt: 200 })

    const pStale = prefetchOutputs(staleSummary)
    const pFresh = prefetchOutputs(freshSummary)
    expect(hostMock).toHaveBeenCalledTimes(2)

    const fresh = makeOutputs({ reply: 'Fresh' })
    const stale = makeOutputs({ reply: 'Stale' })
    resolveFresh(fresh)
    expect(await pFresh).toEqual(fresh)

    // Late arrival of the older request must not overwrite the newer cached version.
    resolveStale(stale)
    expect(await pStale).toEqual(stale)

    const html = renderToStaticMarkup(createElement(Probe, { summary: freshSummary }))
    expect(html).toContain('data-ready="yes"')
    expect(html).toContain('data-reply="Fresh"')
  })

  it('does not cache failed fetches so a later hover can retry', async () => {
    hostMock.mockRejectedValueOnce(new Error('offline'))
    const summary = makeSummary({ id: 'sess-4', updatedAt: 100 })

    const failed = await prefetchOutputs(summary)
    expect(failed).toEqual({ artifacts: [], references: [], reply: null, turnMs: null })
    expect(renderToStaticMarkup(createElement(Probe, { summary }))).toContain('data-ready="no"')

    const recovered = makeOutputs({ reply: 'Recovered' })
    hostMock.mockResolvedValueOnce(recovered)
    expect(await prefetchOutputs(summary)).toEqual(recovered)
    expect(hostMock).toHaveBeenCalledTimes(2)
    expect(renderToStaticMarkup(createElement(Probe, { summary }))).toContain(
      'data-reply="Recovered"',
    )
  })

  it('clears cached and in-flight entries on clearSessionOutputsCache without stale repopulation', async () => {
    let resolveOld!: (value: SessionOutputs) => void
    hostMock.mockImplementationOnce(
      () =>
        new Promise<SessionOutputs>((resolve) => {
          resolveOld = resolve
        }),
    )
    const summary = makeSummary({ id: 'sess-5', updatedAt: 100 })

    const oldPromise = prefetchOutputs(summary)
    expect(hostMock).toHaveBeenCalledTimes(1)

    clearSessionOutputsCache()

    // A new prefetch after clearing starts a fresh request rather than reusing the cleared in-flight one.
    const nextOutputs = makeOutputs({ reply: 'After clear' })
    hostMock.mockResolvedValueOnce(nextOutputs)
    expect(await prefetchOutputs(summary)).toEqual(nextOutputs)
    expect(hostMock).toHaveBeenCalledTimes(2)

    // Clearing again and resolving the pre-clear promise must not repopulate the cache.
    clearSessionOutputsCache()
    resolveOld(makeOutputs({ reply: 'Ghost' }))
    await oldPromise
    expect(renderToStaticMarkup(createElement(Probe, { summary }))).toContain('data-ready="no"')
  })

  it('skips host requests when session id is empty', async () => {
    const empty = await prefetchOutputs({ id: '', updatedAt: 0 })
    expect(empty).toEqual({ artifacts: [], references: [], reply: null, turnMs: null })
    expect(hostMock).not.toHaveBeenCalled()
  })
})
