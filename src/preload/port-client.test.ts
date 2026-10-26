import { MessageChannel, type MessagePort as NodePort } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostResetEvent } from '@shared/ipc'
import {
  isPortError,
  type PortConnectionState,
  type PortError,
  PortRequestError,
  type ToPort,
} from '@shared/port-rpc'
import { type ClientPort, PortClient } from './port-client'

class FakeTransport {
  requests = 0
  private portListener: ((port: ClientPort) => void) | null = null
  private resetListener: ((event: HostResetEvent) => void) | null = null

  requestPort(): void {
    this.requests++
  }

  onPort(listener: (port: ClientPort) => void): void {
    this.portListener = listener
  }

  onReset(listener: (event: HostResetEvent) => void): void {
    this.resetListener = listener
  }

  deliver(port: NodePort): void {
    this.portListener?.(port as unknown as ClientPort)
  }

  reset(failed: boolean): void {
    this.resetListener?.({ failed })
  }
}

/** Waits that resolve once a list holds a given number of items. */
class Counted {
  private waits: { count: number; resolve: () => void }[] = []

  constructor(private readonly items: readonly unknown[]) {}

  /** Call after an item is added. */
  added(): void {
    this.waits = this.waits.filter((wait) => {
      if (this.items.length < wait.count) return true
      wait.resolve()
      return false
    })
  }

  until(count: number): Promise<void> {
    if (this.items.length >= count) return Promise.resolve()
    return new Promise((resolve) => this.waits.push({ count, resolve }))
  }
}

/** A host end that records requests and answers them on demand. */
class FakeHost {
  received: ToPort[] = []
  private readonly counted = new Counted(this.received)
  constructor(readonly port: NodePort) {
    port.on('message', (message: ToPort) => {
      this.received.push(message)
      this.counted.added()
    })
  }

  /** Resolves once `count` requests have come. */
  until(count: number): Promise<void> {
    return this.counted.until(count)
  }

  respond(id: number, result: unknown): void {
    this.port.postMessage({ type: 'response', id, result })
  }

  fail(id: number, code: string, message: string): void {
    this.port.postMessage({ type: 'error', id, error: { code, message, data: { hint: 1 } } })
  }

  emit(event: unknown): void {
    this.port.postMessage({ type: 'event', event })
  }
}

const channels: MessageChannel[] = []

function connectHost(transport: FakeTransport): FakeHost {
  const channel = new MessageChannel()
  channels.push(channel)
  const host = new FakeHost(channel.port1)
  transport.deliver(channel.port2)
  return host
}

function client(lazy = false) {
  const transport = new FakeTransport()
  const states: PortConnectionState[] = []
  const portClient = new PortClient<unknown>({
    label: 'test host',
    methods: ['a.get', 'a.set'],
    transport,
    lazy,
  })
  portClient.onConnection((state) => states.push(state))
  return { transport, portClient, states }
}

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
})

describe('PortClient', () => {
  it('connects at once unless lazy', () => {
    expect(client().transport.requests).toBe(1)
    expect(client(true).transport.requests).toBe(0)
  })

  it('rejects methods outside the allowlist without posting them', async () => {
    const { transport, portClient } = client(true)
    await expect(portClient.request('a.delete', {})).rejects.toMatchObject({
      name: 'PortRequestError',
      code: 'unknown_method',
    })
    expect(transport.requests).toBe(0)
  })

  it('queues requests until the port arrives and resolves them in order', async () => {
    const { transport, portClient, states } = client(true)
    const first = portClient.request('a.get', { n: 1 })
    expect(transport.requests).toBe(1)
    const second = portClient.request('a.set', { n: 2 })
    const host = connectHost(transport)
    await host.until(2)
    expect(states).toEqual(['connected'])
    expect(host.received).toEqual([
      { type: 'request', id: 1, method: 'a.get', params: { n: 1 } },
      { type: 'request', id: 2, method: 'a.set', params: { n: 2 } },
    ])
    host.respond(2, 'two')
    host.respond(1, 'one')
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
  })

  it('rejects with the host error code and data', async () => {
    const { transport, portClient } = client()
    const host = connectHost(transport)
    const pending = portClient.request('a.get', {})
    await host.until(1)
    host.fail(host.received[0].id, 'not_found', 'No such thing')
    const error = await pending.catch((reason: unknown) => reason)
    expect(error).toEqual({
      name: 'PortRequestError',
      code: 'not_found',
      message: 'No such thing',
      data: { hint: 1 },
    })
    expect(isPortError(error)).toBe(true)
    expect(new PortRequestError(error as PortError)).toMatchObject({ code: 'not_found' })
  })

  it('delivers events until unsubscribed', async () => {
    const { transport, portClient } = client()
    const host = connectHost(transport)
    const events: unknown[] = []
    const unsubscribe = portClient.onEvent((event) => events.push(event))
    // A listener that stays: the port delivers in order, so once it has the second event, the
    // first listener would have had it too.
    const staying: unknown[] = []
    const seen = new Counted(staying)
    portClient.onEvent((event) => {
      staying.push(event)
      seen.added()
    })
    host.emit({ type: 'x', n: 1 })
    await seen.until(1)
    unsubscribe()
    host.emit({ type: 'x', n: 2 })
    await seen.until(2)
    expect(events).toEqual([{ type: 'x', n: 1 }])
  })

  it('tells a new listener the current state', () => {
    const { transport, portClient } = client()
    connectHost(transport)
    const states: PortConnectionState[] = []
    portClient.onConnection((state) => states.push(state))
    expect(states).toEqual(['connected'])
  })

  it('rejects in-flight requests on reset and reconnects with fresh ids', async () => {
    const { transport, portClient, states } = client()
    const first = connectHost(transport)
    const inFlight = portClient.request('a.get', {})
    await first.until(1)
    transport.reset(false)
    await expect(inFlight).rejects.toMatchObject({ code: 'host_restarted' })
    expect(states).toEqual(['connected', 'reconnecting'])
    expect(transport.requests).toBe(2)

    const waiting = portClient.request('a.get', { again: true })
    const host = connectHost(transport)
    await host.until(1)
    expect(states).toEqual(['connected', 'reconnecting', 'connected'])
    expect(host.received).toEqual([
      { type: 'request', id: 1, method: 'a.get', params: { again: true } },
    ])
    host.respond(1, 'ok')
    await expect(waiting).resolves.toBe('ok')
  })

  it('fails fast while the host has failed, and recovers after a restart', async () => {
    const { transport, portClient, states } = client()
    const queued = portClient.request('a.get', {})
    transport.reset(true)
    await expect(queued).rejects.toMatchObject({ code: 'host_restarted' })
    await expect(portClient.request('a.get', {})).rejects.toMatchObject({
      code: 'host_restarted',
    })
    expect(states).toEqual(['failed'])
    transport.reset(false)
    expect(states).toEqual(['failed', 'reconnecting'])
    connectHost(transport)
    expect(states.at(-1)).toBe('connected')
  })

  it('ignores resets for a lazy host it never asked for', () => {
    const { transport, states } = client(true)
    transport.reset(false)
    expect(states).toEqual([])
    expect(transport.requests).toBe(0)
  })

  it('rejects params that cannot cross the port', async () => {
    const { transport, portClient } = client()
    connectHost(transport)
    await expect(portClient.request('a.get', { fn: () => {} })).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})
