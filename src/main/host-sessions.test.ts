import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostStatus } from '@shared/remote/hosts'

vi.mock('electron', () => ({ MessageChannelMain: class {} }))
vi.mock('./log', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}))

const { HostSessions } = await import('./host-sessions')

/** One end of a port: what was posted to it, and a way to deliver a message to its listener. */
class FakePort {
  posted: unknown[] = []
  closed = false
  started = false
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = {}
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  on(event: 'message', listener: (event: { data: unknown }) => void): this
  on(event: 'close', listener: () => void): this
  on(event: string, listener: (event: { data: unknown }) => void): this {
    ;(this.listeners[event] ??= []).push(listener)
    return this
  }
  start(): void {
    this.started = true
  }
  close(): void {
    this.closed = true
  }
  deliver(data: unknown): void {
    for (const listener of this.listeners.message ?? []) listener({ data })
  }
  hangUp(): void {
    for (const listener of this.listeners.close ?? []) listener({ data: null })
  }
}

const devBox = 'a'.repeat(32)
const mini = 'b'.repeat(32)

const status = (id: string, state: 'connecting' | 'online' | 'offline'): HostStatus =>
  ({
    id,
    connection: state === 'online' ? { state, address: { host: 'x', port: 1 } } : { state },
  }) as HostStatus

const request = (hostId: string, id: number, method = 'sessions.list', params: unknown = {}) => ({
  hostId,
  message: { type: 'request', id, method, params },
})

function setup(holdMs = 1000) {
  const relay = new HostSessions({ holdMs })
  const window = new FakePort()
  relay.attach(window)
  return { relay, window }
}

describe('HostSessions', () => {
  afterEach(() => vi.useRealTimers())

  it('sends a request to its host under an id of its own and answers the window that asked', () => {
    const { relay, window } = setup()
    const other = new FakePort()
    relay.attach(other)
    const port = new FakePort()
    relay.opened(devBox, port)
    expect(window.posted).toEqual([{ kind: 'open', hostId: devBox }])
    window.deliver(request(devBox, 7))
    other.deliver(request(devBox, 7))
    expect(port.posted).toEqual([
      { type: 'request', id: 1, method: 'sessions.list', params: {} },
      { type: 'request', id: 2, method: 'sessions.list', params: {} },
    ])
    port.deliver({ type: 'response', id: 2, result: ['b'] })
    port.deliver({ type: 'response', id: 1, result: ['a'] })
    expect(window.posted.at(-1)).toEqual({
      kind: 'message',
      hostId: devBox,
      message: { type: 'response', id: 7, result: ['a'] },
    })
    expect(other.posted.at(-1)).toEqual({
      kind: 'message',
      hostId: devBox,
      message: { type: 'response', id: 7, result: ['b'] },
    })
  })

  it("tells every window of a host's events and resyncs, and a new window of the open hosts", () => {
    const { relay, window } = setup()
    const port = new FakePort()
    relay.opened(devBox, port)
    const event = { type: 'event', event: { type: 'session.removed', sessionId: 's' } }
    port.deliver(event)
    port.deliver({ type: 'resync' })
    port.deliver({ type: 'something-else' })
    expect(window.posted.slice(1)).toEqual([
      { kind: 'message', hostId: devBox, message: event },
      { kind: 'message', hostId: devBox, message: { type: 'resync' } },
    ])
    const later = new FakePort()
    relay.attach(later)
    expect(later.posted).toEqual([{ kind: 'open', hostId: devBox }])
  })

  it('fails what was in flight when the session ends, and a new session starts afresh', () => {
    const { relay, window } = setup()
    const port = new FakePort()
    relay.opened(devBox, port)
    window.deliver(request(devBox, 3))
    port.hangUp()
    relay.closed(devBox, port)
    expect(window.posted.slice(1)).toEqual([
      {
        kind: 'message',
        hostId: devBox,
        message: {
          type: 'error',
          id: 3,
          error: { code: 'host_restarted', message: 'The connection to the host ended' },
        },
      },
      { kind: 'closed', hostId: devBox },
    ])
    // An answer on the old port reaches no one.
    port.deliver({ type: 'response', id: 1, result: [] })
    expect(window.posted).toHaveLength(3)
    const next = new FakePort()
    relay.opened(devBox, next)
    window.deliver(request(devBox, 4))
    expect(next.posted).toEqual([{ type: 'request', id: 2, method: 'sessions.list', params: {} }])
  })

  it('holds requests while a host connects, and sends them once its session opens', () => {
    const { relay, window } = setup()
    relay.connections([status(devBox, 'connecting')])
    window.deliver(request(devBox, 1))
    expect(window.posted).toEqual([])
    const port = new FakePort()
    relay.opened(devBox, port)
    expect(port.posted).toEqual([{ type: 'request', id: 1, method: 'sessions.list', params: {} }])
  })

  it('fails held requests once the host is offline, or after a while', () => {
    vi.useFakeTimers()
    const { relay, window } = setup(1000)
    const offline = {
      code: 'host_offline',
      message: 'The host is not connected',
    }
    relay.connections([status(devBox, 'connecting'), status(mini, 'connecting')])
    window.deliver(request(devBox, 1))
    window.deliver(request(mini, 2))
    relay.connections([status(devBox, 'offline'), status(mini, 'connecting')])
    expect(window.posted).toEqual([
      { kind: 'message', hostId: devBox, message: { type: 'error', id: 1, error: offline } },
    ])
    vi.advanceTimersByTime(1000)
    expect(window.posted.at(-1)).toEqual({
      kind: 'message',
      hostId: mini,
      message: { type: 'error', id: 2, error: offline },
    })
    // A host not trying fails at once.
    window.deliver(request(devBox, 3))
    expect(window.posted.at(-1)).toMatchObject({ message: { id: 3, error: offline } })
  })

  it('refuses what names no host or no method of the host protocol', () => {
    const { relay, window } = setup()
    relay.opened(devBox, new FakePort())
    window.deliver(request('not-a-host', 1))
    window.deliver(request(devBox, 2, 'shell.run'))
    window.deliver({ hostId: devBox, message: { type: 'event' } })
    expect(window.posted.slice(1)).toEqual([
      {
        kind: 'message',
        hostId: 'not-a-host',
        message: {
          type: 'error',
          id: 1,
          error: { code: 'invalid_params', message: 'A request for another host must name it' },
        },
      },
      {
        kind: 'message',
        hostId: devBox,
        message: {
          type: 'error',
          id: 2,
          error: { code: 'unknown_method', message: 'Unknown method "shell.run"' },
        },
      },
    ])
  })

  it('closes every port when Kettu quits', () => {
    const { relay, window } = setup()
    const port = new FakePort()
    relay.opened(devBox, port)
    relay.close()
    expect(port.closed).toBe(true)
    expect(window.closed).toBe(true)
  })
})
