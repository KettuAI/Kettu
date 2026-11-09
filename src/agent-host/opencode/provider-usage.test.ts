import { describe, expect, it, vi } from 'vitest'
import { failedUsage, readProviderUsage, unsupportedUsage, USAGE_ERROR } from './provider-usage'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchOnce(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => json(body, status)) as unknown as typeof fetch
}

describe('readProviderUsage', () => {
  it('leaves a provider without a known endpoint unsupported and sends nothing', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    expect(await readProviderUsage({ providerId: 'mystery', key: 'k', now: 7, fetch })).toEqual(
      unsupportedUsage(7),
    )
    expect(await readProviderUsage({ providerId: 'constructor', key: 'k', now: 7, fetch })).toEqual(
      unsupportedUsage(7),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('turns a failed request, a redirect and a malformed answer into one generic error', async () => {
    const server = await readProviderUsage({
      providerId: 'deepseek',
      key: 'sk-leak',
      now: 8,
      fetch: fetchOnce({ error: 'bad key sk-leak' }, 500),
    })
    expect(server).toEqual(failedUsage(8))
    expect(JSON.stringify(server)).not.toContain('sk-leak')

    const redirect = await readProviderUsage({
      providerId: 'deepseek',
      key: 'sk-leak',
      now: 8,
      fetch: vi.fn(async () => {
        throw new TypeError('unexpected redirect')
      }) as unknown as typeof globalThis.fetch,
    })
    expect(redirect).toEqual(failedUsage(8))

    const malformed = await readProviderUsage({
      providerId: 'deepseek',
      key: 'k',
      now: 8,
      fetch: fetchOnce({ balance_infos: 'no' }),
    })
    expect(malformed).toEqual(failedUsage(8))
  })

  it('refuses an answer larger than the bound without reading it all', async () => {
    const usage = await readProviderUsage({
      providerId: 'deepseek',
      key: 'k',
      now: 8,
      fetch: fetchOnce({ balance_infos: [], padding: 'x'.repeat(70 * 1024) }),
    })
    expect(usage).toEqual(failedUsage(8))
  })

  it('uses one generic error text', () => {
    expect(USAGE_ERROR).toBe('Usage could not be read.')
  })
})
