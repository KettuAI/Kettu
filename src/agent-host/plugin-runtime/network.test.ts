import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { domainCovers } from '@shared/plugins'
import {
  FETCH_REQUEST_BYTES,
  httpsTransport,
  isPublicAddress,
  networkFetch,
  publicLookup,
  type HttpRequest,
  type HttpTransport,
} from './network'

const PERMISSIONS = ['network:api.example.com', 'network:*.cdn.example.org', 'sessions.summary']

function setup() {
  const sent: HttpRequest[] = []
  const transport: HttpTransport = vi.fn(async (request) => {
    sent.push(request)
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }
  })
  const run = (url: unknown, init?: unknown, permissions: string[] = PERMISSIONS) =>
    networkFetch(transport).run({ pluginId: 'p0123456789ab', permissions }, [url, init])
  return { run, sent, transport }
}

describe('the domains a network permission covers', () => {
  it('is the host itself, or what lies under it for a wildcard, and never a look-alike', () => {
    expect(domainCovers('api.example.com', 'api.example.com')).toBe(true)
    expect(domainCovers('api.example.com', 'v2.api.example.com')).toBe(false)
    expect(domainCovers('api.example.com', 'example.com')).toBe(false)
    expect(domainCovers('api.example.com', 'evilapi.example.com')).toBe(false)
    expect(domainCovers('*.cdn.example.org', 'a.cdn.example.org')).toBe(true)
    expect(domainCovers('*.cdn.example.org', 'a.b.cdn.example.org')).toBe(true)
    expect(domainCovers('*.cdn.example.org', 'cdn.example.org')).toBe(false)
    expect(domainCovers('*.cdn.example.org', 'acdn.example.org')).toBe(false)
    expect(domainCovers('*.cdn.example.org', 'cdn.example.org.evil.com')).toBe(false)
  })
})

describe('network.fetch', () => {
  it('reaches a granted host over https and hands back the response', async () => {
    const { run, sent } = setup()
    expect(await run('HTTPS://API.Example.com/v1/items?limit=2')).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'ok',
    })
    expect(sent[0]).toMatchObject({ method: 'GET', body: null })
    expect(sent[0]!.url.href).toBe('https://api.example.com/v1/items?limit=2')
    expect(sent[0]!.headers).toEqual({ 'user-agent': 'Kettu', 'accept-encoding': 'identity' })
    await run('https://a.b.cdn.example.org/x.js')
    expect(sent).toHaveLength(2)
  })

  it('refuses a host no permission names, saying which permission it would need', async () => {
    const { run, transport } = setup()
    const refused = [
      'https://evil.example.net/',
      'https://example.com/',
      'https://v2.api.example.com/',
      'https://cdn.example.org/',
      'https://api.example.com.evil.net/',
      // Trailing dot, an address and a name without a dot are not the host a permission names.
      'https://api.example.com./',
      'https://93.184.216.34/',
      'https://[::1]/',
      'https://localhost/',
    ]
    for (const url of refused) {
      await expect(run(url), url).rejects.toThrow(/not among the domains this plugin may reach/)
    }
    await expect(run('https://evil.example.net/x')).rejects.toThrow(
      'It needs the permission "network:evil.example.net"',
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a plugin with no network permission at all', async () => {
    const { run, transport } = setup()
    await expect(run('https://api.example.com/', undefined, ['sessions.summary'])).rejects.toThrow(
      'network:api.example.com',
    )
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses what is not a plain https address on the default port', async () => {
    const { run, transport } = setup()
    for (const url of [
      'http://api.example.com/',
      'ftp://api.example.com/',
      'https://api.example.com:8443/',
      'https://user:secret@api.example.com/',
      'file:///etc/passwd',
      'not a url',
      '//api.example.com/',
      42,
      undefined,
      `https://api.example.com/${'a'.repeat(3000)}`,
    ]) {
      await expect(run(url), String(url).slice(0, 40)).rejects.toThrow()
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('takes a method, headers and a body it can send, and no more', async () => {
    const { run, sent, transport } = setup()
    await run('https://api.example.com/', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'My plugin' },
      body: '{}',
    })
    expect(sent[0]).toMatchObject({ method: 'POST', body: '{}' })
    expect(sent[0]!.headers).toEqual({
      'user-agent': 'My plugin',
      'accept-encoding': 'identity',
      'content-type': 'application/json',
    })
    const bad: unknown[] = [
      { method: 'TRACE' },
      { method: 'CONNECT' },
      { method: 5 },
      { body: 5 },
      { body: 'x' },
      { method: 'POST', body: 'x'.repeat(FETCH_REQUEST_BYTES + 1) },
      { headers: { Host: 'example.net' } },
      { headers: { 'Content-Length': '5' } },
      { headers: { 'X Bad': 'x' } },
      { headers: { Accept: 5 } },
      { headers: 'text' },
      'POST',
      ['GET'],
    ]
    for (const init of bad) {
      await expect(
        run('https://api.example.com/', init),
        JSON.stringify(init)?.slice(0, 40),
      ).rejects.toThrow()
    }
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('the addresses a plugin may connect to', () => {
  it('are public ones: not this computer, a private network or a link-local address', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not an address',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    for (const address of [
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      // What a proxy tool in fake-IP mode answers with.
      '198.18.0.12',
    ]) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('are filtered out of a name that resolves to several', async () => {
    const lookup = publicLookup((_, __, callback) =>
      callback(null, [
        { address: '10.0.0.5', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    )
    const answers = await new Promise<unknown[]>((resolve) => {
      lookup('api.example.com', { all: true }, (error, address) => resolve([error, address]))
    })
    expect(answers).toEqual([null, [{ address: '93.184.216.34', family: 4 }]])
    const one = await new Promise<unknown[]>((resolve) => {
      lookup('api.example.com', {}, (error, address, family) => resolve([error, address, family]))
    })
    expect(one).toEqual([null, '93.184.216.34', 4])
  })

  it('fail a name that resolves only to this computer or a private network', async () => {
    const lookup = publicLookup((_, __, callback) =>
      callback(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ]),
    )
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup('rebinding.example.com', { all: true }, (failure) => resolve(failure))
    })
    expect(error?.message).toContain('resolves to an address on this computer')
  })

  it('keep the request away from a server on this computer even under a granted name', async () => {
    let connections = 0
    const server = createServer(() => {
      connections++
    })
    server.on('connection', () => connections++)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      // `localhost` resolves to this computer as a name under a permission would.
      await expect(
        httpsTransport({
          url: new URL(`https://localhost:${port}/`),
          method: 'GET',
          headers: {},
          body: null,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow('resolves to an address on this computer')
      expect(connections).toBe(0)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
