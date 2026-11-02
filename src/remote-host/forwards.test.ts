// The forwards on both sides of a device's channel, wired to each other in memory: a page's
// connection on the desktop app's loopback reaches a dev server on the host's, both ways.

import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamCancel } from '@shared/remote/streams'
import { ClientForwards } from './client-forwards'
import { HostForwards } from './forwards'

const closers: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** A dev server on the host's loopback that answers with the path it was asked for. */
async function devServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => res.end(`${req.method} ${req.url} ${body}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return (server.address() as net.AddressInfo).port
}

function get(port: number, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', agent: false },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** Both sides, each one's messages delivered to the other as the channel would, in order. */
function wired(options: { linked?: () => boolean } = {}) {
  const linked = options.linked ?? (() => true)
  const toDevice: unknown[] = []
  const cancels: StreamCancel[] = []
  // The client, made after the host it sends to.
  const ends: { client?: ClientForwards } = {}
  const host = new HostForwards({
    send: (message) => {
      toDevice.push(message)
      if (message.type === 'stream.cancel') cancels.push(message)
      queueMicrotask(() => ends.client!.message(message))
    },
    sendBytes: (stream, data) => {
      const copy = data.slice()
      queueMicrotask(() => ends.client!.bytes(stream, copy))
    },
    transport: { buffered: () => 0, drained: () => Promise.resolve() },
    log: () => {},
  })
  let nextStream = 1
  const client = new ClientForwards({
    send: (message) => {
      if (!linked()) return false
      queueMicrotask(() => {
        if (message.type === 'forward.open') host.open(message.stream, { ...message })
        else if (message.type === 'stream.end') host.end(message.stream)
        else host.cancel(message.stream)
      })
      return true
    },
    sendBytes: (stream, data) => {
      if (!linked()) return null
      const copy = data.slice()
      queueMicrotask(() => host.bytes(stream, copy))
      return Promise.resolve()
    },
    nextStream: () => {
      const stream = nextStream
      nextStream += 2
      return stream
    },
    log: () => {},
  })
  ends.client = client
  closers.push(() => {
    client.closeAll()
    host.close()
  })
  const grant = (sessionId: string, port: number, name: 'localhost' | '127.0.0.1' = '127.0.0.1') =>
    host.observe({
      type: 'event',
      event: {
        type: 'browser.call',
        call: { sessionId, forward: { host: name, port } },
      },
    })
  return { host, client, grant, toDevice, cancels }
}

describe('forwards to a dev server on the host', () => {
  it('carry a page’s requests and their answers both ways', async () => {
    const devPort = await devServer()
    const { client, grant } = wired()
    grant('s1', devPort)
    const local = await client.listen('s1', { host: '127.0.0.1', port: devPort })
    expect(local).toEqual(expect.any(Number))
    expect(local).not.toBe(devPort)
    // The same page and port listen once.
    expect(await client.listen('s1', { host: '127.0.0.1', port: devPort })).toBe(local)
    expect(await get(local!, '/app?x=1')).toEqual({ status: 200, text: 'GET /app?x=1 ' })
    expect(await get(local!, '/save', 'a'.repeat(200_000))).toEqual({
      status: 200,
      text: `POST /save ${'a'.repeat(200_000)}`,
    })
  })

  it('reach only a port an agent of that session opened', async () => {
    const devPort = await devServer()
    const { client, grant, cancels } = wired()
    grant('s1', devPort)
    const other = await client.listen('s2', { host: '127.0.0.1', port: devPort })
    await expect(get(other!, '/')).rejects.toThrow()
    expect(cancels).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'forbidden' }) }),
    ])
  })

  it('say when nothing listens on the port', async () => {
    const free = await devServer()
    // The server's port, closed again, as a dev server that stopped leaves it.
    await closers.pop()!()
    const { client, grant, cancels } = wired()
    grant('s1', free)
    const local = await client.listen('s1', { host: '127.0.0.1', port: free })
    await expect(get(local!, '/')).rejects.toThrow()
    await expect.poll(() => cancels.length).toBe(1)
    expect(cancels[0]!.error).toEqual({
      code: 'unavailable',
      message: `Nothing listens on port ${free} on the host`,
    })
  })

  it('close with the page, and with the host’s session', async () => {
    const devPort = await devServer()
    const { client, host, grant } = wired()
    grant('s1', devPort)
    const first = await client.listen('s1', { host: '127.0.0.1', port: devPort })
    client.close('s1')
    await expect(get(first!, '/')).rejects.toThrow()

    const second = await client.listen('s1', { host: '127.0.0.1', port: devPort })
    expect(await get(second!, '/')).toMatchObject({ status: 200 })
    host.close()
    // Its grants went with it, so a new connection is refused.
    await expect(get(second!, '/')).rejects.toThrow()
    client.closeAll()
    await expect(get(second!, '/')).rejects.toThrow()
  })

  it('take no connection while the link has none', async () => {
    const devPort = await devServer()
    let up = false
    const { client, grant } = wired({ linked: () => up })
    grant('s1', devPort)
    const local = await client.listen('s1', { host: '127.0.0.1', port: devPort })
    await expect(get(local!, '/')).rejects.toThrow()
    up = true
    expect(await get(local!, '/')).toMatchObject({ status: 200 })
  })
})
