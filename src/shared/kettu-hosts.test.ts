import { describe, expect, it, vi } from 'vitest'
import { AccountNetworkError, type AccountFetch } from './account-api'
import { guardKettuFetch, isKettuServiceUrl } from './kettu-hosts'

describe("Kettu's service hosts", () => {
  it('names the domains and every subdomain of them', () => {
    for (const url of [
      'https://kettu.sh/pair',
      'https://www.kettu.sh/api/v1/me',
      'https://relay.kettu.sh/v1',
      'wss://eu.relay.kettu.sh/v1/host/abc',
      'https://push.kettu.sh/v1/push',
      'https://kettu.page/',
      'https://a1b2c3d4e5.kettu.page/index.html',
      'https://WWW.KETTU.SH/api/v1/shares',
      'https://www.kettu.sh./api/v1/me',
      'https://www.kettu.sh:8443/api',
      'https://user@www.kettu.sh/api',
    ]) {
      expect(isKettuServiceUrl(url), url).toBe(true)
    }
  })

  it('leaves out look-alikes and every other host', () => {
    for (const url of [
      'https://evilkettu.sh/',
      'https://kettu.sh.evil.com/',
      'https://www.kettu.sh@evil.com/',
      'https://evilkettu.page/',
      'https://kettu.pages.dev/',
      'https://kettu.show/',
      'https://api.cloudflare.com/client/v4/accounts',
      'https://my-page.example.workers.dev/',
      'https://avatars.githubusercontent.com/u/1',
      'file:///Users/me/kettu.sh',
      'not a url',
    ]) {
      expect(isKettuServiceUrl(url), url).toBe(false)
    }
  })

  it('also names the origins it is given, and only them', () => {
    const origins = ['http://localhost:8787']
    expect(isKettuServiceUrl('http://localhost:8787/api/v1/me', origins)).toBe(true)
    expect(isKettuServiceUrl('http://localhost:8788/api/v1/me', origins)).toBe(false)
    expect(isKettuServiceUrl('https://localhost:8787/api/v1/me', origins)).toBe(false)
    expect(isKettuServiceUrl('file:///tmp/x', ['not a url'])).toBe(false)
  })
})

describe('the fetch guard', () => {
  const answered = () => vi.fn<AccountFetch>(async () => new Response('ok'))

  it("refuses Kettu's services while they are off, without asking the network", async () => {
    const fetch = answered()
    const guarded = guardKettuFetch(fetch, () => false, ['http://localhost:8787'])
    for (const url of [
      'https://www.kettu.sh/api/oauth/token',
      'https://www.kettu.sh/api/v1/shares',
      'https://relay.kettu.sh/v1',
      'https://x.kettu.page/',
      'http://localhost:8787/api/v1/me',
    ]) {
      await expect(guarded(url, {}), url).rejects.toBeInstanceOf(AccountNetworkError)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets every other host through while they are off', async () => {
    const fetch = answered()
    const guarded = guardKettuFetch(fetch, () => false)
    await guarded('https://api.cloudflare.com/client/v4/accounts', {})
    await guarded('https://evilkettu.sh/', {})
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.cloudflare.com/client/v4/accounts',
      'https://evilkettu.sh/',
    ])
  })

  it('lets Kettu through while they are on, reading the switch on each request', async () => {
    let cloud = true
    const fetch = answered()
    const guarded = guardKettuFetch(fetch, () => cloud)
    await guarded('https://www.kettu.sh/api/v1/me', {})
    expect(fetch).toHaveBeenCalledTimes(1)
    cloud = false
    await expect(guarded('https://www.kettu.sh/api/v1/me', {})).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
