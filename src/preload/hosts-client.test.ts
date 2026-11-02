import { describe, expect, it } from 'vitest'
import type { HostSessionChange } from '@shared/host-sessions'
import { HostsClient } from './hosts-client'
import type { ClientPort } from './port-client'

class FakePort implements ClientPort {
  posted: unknown[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  started = false
  closed = false
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  start(): void {
    this.started = true
  }
  close(): void {
    this.closed = true
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }
}

function setup() {
  let requests = 0
  let give: (port: ClientPort) => void = () => {}
  const client = new HostsClient({
    requestPort: () => requests++,
    onPort: (listener) => (give = listener),
  })
  return { client, give: (port: ClientPort) => give(port), requests: () => requests }
}

const devBox = 'a'.repeat(32)

describe('HostsClient', () => {
  it('asks for its port on first use and sends what waited once it comes', async () => {
    const { client, give, requests } = setup()
    expect(requests()).toBe(0)
    const answer = client.request(devBox, 'sessions.list', {})
    expect(requests()).toBe(1)
    const port = new FakePort()
    give(port)
    expect(port.posted).toEqual([
      { hostId: devBox, message: { type: 'request', id: 1, method: 'sessions.list', params: {} } },
    ])
    port.deliver({
      kind: 'message',
      hostId: devBox,
      message: { type: 'response', id: 1, result: ['s'] },
    })
    await expect(answer).resolves.toEqual(['s'])
  })

  it("rejects with the host's error, and an unknown method at once", async () => {
    const { client, give } = setup()
    const port = new FakePort()
    client.onSession(() => {})
    give(port)
    const answer = client.request(devBox, 'sessions.open', { sessionId: 'x' })
    port.deliver({
      kind: 'message',
      hostId: devBox,
      message: { type: 'error', id: 1, error: { code: 'host_offline', message: 'gone' } },
    })
    await expect(answer).rejects.toMatchObject({ code: 'host_offline', message: 'gone' })
    await expect(client.request(devBox, 'shell.run', {})).rejects.toMatchObject({
      code: 'unknown_method',
    })
  })

  it("sends an owner's calls to the host, and path completion", () => {
    const { client, give } = setup()
    const port = new FakePort()
    client.onSession(() => {})
    give(port)
    void client.request(devBox, 'settings.get', undefined)
    void client.request(devBox, 'paths.complete', { path: '/ho' })
    expect(port.posted).toEqual([
      { hostId: devBox, message: { type: 'request', id: 1, method: 'settings.get' } },
      {
        hostId: devBox,
        message: { type: 'request', id: 2, method: 'paths.complete', params: { path: '/ho' } },
      },
    ])
  })

  it("tells its listeners of each host's session and events", () => {
    const { client, give } = setup()
    const heard: [string, HostSessionChange][] = []
    client.onSession((hostId, change) => heard.push([hostId, change]))
    const port = new FakePort()
    give(port)
    const event = { type: 'session.removed', sessionId: 's' }
    port.deliver({ kind: 'open', hostId: devBox })
    port.deliver({ kind: 'message', hostId: devBox, message: { type: 'event', event } })
    port.deliver({ kind: 'message', hostId: devBox, message: { type: 'resync' } })
    port.deliver({
      kind: 'message',
      hostId: devBox,
      message: { type: 'terminals.restarted', ids: ['t1', 7] },
    })
    port.deliver({ kind: 'closed', hostId: devBox })
    expect(heard).toEqual([
      [devBox, { kind: 'open' }],
      [devBox, { kind: 'event', event }],
      [devBox, { kind: 'resync' }],
      [devBox, { kind: 'terminals-restarted', ids: ['t1'] }],
      [devBox, { kind: 'closed' }],
    ])
  })
})
