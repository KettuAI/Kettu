import { describe, expect, it, vi } from 'vitest'
import { askVendor, readerOpen, UsageReadError, type SignInPlace } from './stored-sign-in'

const SECRET = 'sk-stored-secret-123'

function place(fetch: typeof globalThis.fetch): SignInPlace {
  return { env: {}, home: '/nowhere', platform: 'linux', now: 1_000, fetch }
}

function reply(body: string, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof globalThis.fetch
}

describe('askVendor', () => {
  it('refuses an origin that is not listed before sending anything', async () => {
    const fetch = reply('{}')
    for (const url of ['https://evil.example/usage', 'http://api.vendor.test/usage', 'not a url']) {
      await expect(
        askVendor(
          {
            vendor: 'Vendor',
            origins: ['https://api.vendor.test'],
            url,
            headers: { authorization: `Bearer ${SECRET}` },
          },
          place(fetch),
        ),
      ).rejects.toThrow(UsageReadError)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends the credential only to the listed endpoint, with redirects refused', async () => {
    const fetch = reply('{"ok":true}')
    const body = await askVendor(
      {
        vendor: 'Vendor',
        origins: ['https://api.vendor.test'],
        url: 'https://api.vendor.test/usage',
        headers: { authorization: `Bearer ${SECRET}` },
      },
      place(fetch),
    )
    expect(body).toEqual({ ok: true })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('https://api.vendor.test/usage')
    expect(init?.redirect).toBe('error')
  })

  it('never puts the answer or the credential into its errors', async () => {
    const echoed = `{"error":"bad token ${SECRET}"}`
    for (const fetch of [
      reply(echoed, 401),
      reply(echoed, 500),
      reply(`not json ${SECRET}`),
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${SECRET}`)
      }) as unknown as typeof globalThis.fetch,
    ]) {
      const error = await askVendor(
        {
          vendor: 'Vendor',
          origins: ['https://api.vendor.test'],
          url: 'https://api.vendor.test/usage',
          headers: { authorization: `Bearer ${SECRET}` },
        },
        place(fetch),
      ).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(UsageReadError)
      expect(String((error as Error).message)).not.toContain(SECRET)
      expect(JSON.stringify(error)).not.toContain(SECRET)
    }
  })

  it('refuses an answer larger than the bound', async () => {
    const fetch = reply(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }))
    await expect(
      askVendor(
        {
          vendor: 'Vendor',
          origins: ['https://api.vendor.test'],
          url: 'https://api.vendor.test/usage',
          headers: {},
        },
        place(fetch),
      ),
    ).rejects.toThrow("Vendor's usage reply could not be read")
  })
})

describe('readerOpen', () => {
  it('opens on the checked version and later ones', () => {
    const reader = { version: '2.6.2', read: vi.fn() }
    expect(readerOpen(reader, '2.6.2')).toBe(true)
    expect(readerOpen(reader, '2.6.3')).toBe(true)
    expect(readerOpen(reader, '3.0.0')).toBe(true)
    expect(readerOpen(reader, '2.6.1')).toBe(false)
    expect(readerOpen(reader, null)).toBe(false)
    const devin = { version: '3000.11.228', read: vi.fn() }
    expect(readerOpen(devin, '3000.12.1')).toBe(true)
    expect(readerOpen(devin, '3000.11.200')).toBe(false)
  })
})
