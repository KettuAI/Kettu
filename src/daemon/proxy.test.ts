import http, { type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ProxySettings } from '@shared/settings'
import { proxiedFetch } from './proxy'

let target: Server
let proxy: Server
let proxyUrl = ''
/** What reached the proxy: a tunnel's host and port, or a request's absolute URL. */
const proxied: string[] = []
const tunnels = new Set<Socket>()

const port = (server: Server): number => (server.address() as AddressInfo).port
const listen = (server: Server): Promise<void> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

beforeAll(async () => {
  target = http.createServer((request, response) => response.end(`catalog ${request.url}`))
  // A proxy that alone reaches the catalog: whatever host a request names, it goes to the target.
  proxy = http.createServer((request, response) => {
    proxied.push(request.url!)
    const path = new URL(request.url!).pathname
    http.get({ host: '127.0.0.1', port: port(target), path }, (answer) => answer.pipe(response))
  })
  proxy.on('connect', (request: http.IncomingMessage, socket: Socket) => {
    proxied.push(request.url!)
    tunnels.add(socket)
    const upstream = connect(port(target), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    tunnels.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await listen(target)
  await listen(proxy)
  proxyUrl = `http://127.0.0.1:${port(proxy)}`
})

beforeEach(() => {
  proxied.length = 0
})

afterAll(async () => {
  // Back to no proxy, as the process started.
  await read(
    proxiedFetch(() => ({ mode: 'environment' }), {}),
    `http://127.0.0.1:${port(target)}/`,
  )
  for (const socket of tunnels) socket.destroy()
  target.closeAllConnections()
  target.close()
  proxy.closeAllConnections()
  proxy.close()
})

async function read(fetch: ReturnType<typeof proxiedFetch>, url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  return response.text()
}

describe('proxiedFetch', () => {
  it('goes through the custom proxy, whatever the environment names', async () => {
    const custom: ProxySettings = { mode: 'custom', url: proxyUrl, noProxy: '' }
    const fetch = proxiedFetch(() => custom, { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: '' })
    expect(await read(fetch, 'http://catalog.test/index.json')).toBe('catalog /index.json')
    expect(proxied).toHaveLength(1)
    expect(proxied[0]).toContain('catalog.test')
  })

  it("goes through the environment's proxy when that is the setting", async () => {
    const fetch = proxiedFetch(() => ({ mode: 'environment' }), { HTTP_PROXY: proxyUrl })
    expect(await read(fetch, 'http://catalog.test/themes/a.json')).toBe('catalog /themes/a.json')
    expect(proxied).toHaveLength(1)
    expect(proxied[0]).toContain('catalog.test')
  })

  it('connects directly without a proxy, and to what NO_PROXY names', async () => {
    const direct = `http://127.0.0.1:${port(target)}/index.json`
    expect(
      await read(
        proxiedFetch(() => ({ mode: 'environment' }), {}),
        direct,
      ),
    ).toBe('catalog /index.json')
    const bypassed: ProxySettings = { mode: 'custom', url: proxyUrl, noProxy: 'catalog.test' }
    // Nothing answers for catalog.test but the proxy, so the direct try fails.
    await expect(
      read(
        proxiedFetch(() => bypassed, {}),
        'http://catalog.test/',
      ),
    ).rejects.toThrow()
    expect(proxied).toEqual([])
  })

  it('follows a change of the setting with the next request', async () => {
    let setting: ProxySettings = { mode: 'custom', url: proxyUrl, noProxy: '' }
    const fetch = proxiedFetch(() => setting, {})
    await read(fetch, 'http://catalog.test/index.json')
    expect(proxied).toHaveLength(1)
    setting = { mode: 'environment' }
    await expect(read(fetch, 'http://catalog.test/index.json')).rejects.toThrow()
    expect(proxied).toHaveLength(1)
  })
})
