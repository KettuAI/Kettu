import { afterEach, describe, expect, it } from 'vitest'
import { FakeRelays, type FakeSocket } from './fake-relay'
import { importRelayKey, newRelaySeed, relayHostId, type RelayKey } from './relay'
import { dialRelay } from './relay-device'
import { RelayHost, type RelayHostOptions, type RelayHostTimings } from './relay-host'

const MAIN = 'https://relay.kettu.test'
const REGION = 'https://hk.relay.kettu.test'
const FAST: Partial<RelayHostTimings> = {
  retryMs: 10,
  maxRetryMs: 40,
  refusedMs: 30,
  pingMs: 40,
  pongMs: 30,
  conflictWindowMs: 60_000,
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const hosts: RelayHost[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.stop()
})

async function setup(): Promise<{ relays: FakeRelays; key: RelayKey; id: string }> {
  const relays = new FakeRelays()
  relays.accounts.set('token-a', 'account-a')
  relays.accounts.set('token-a2', 'account-a')
  relays.accounts.set('token-b', 'account-b')
  relays.relay(MAIN).regions = [{ id: 'hk', url: REGION }]
  const key = await importRelayKey(await newRelaySeed())
  return { relays, key, id: await relayHostId(key.publicKey) }
}

function start(
  relays: FakeRelays,
  options: Pick<RelayHostOptions, 'id' | 'key'> & Partial<RelayHostOptions>,
): { host: RelayHost; accepted: { socket: WebSocket; relay: string }[] } {
  const accepted: { socket: WebSocket; relay: string }[] = []
  const host = new RelayHost({
    main: MAIN,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket, relay) => accepted.push({ socket, relay }),
    changed: () => {},
    log: () => {},
    timings: FAST,
    ...options,
  })
  hosts.push(host)
  host.start()
  return { host, accepted }
}

const states = (host: RelayHost): string[] => host.status.map((relay) => relay.connection.state)

describe('the host on the relay', () => {
  it('signs in to the main relay and each region it lists', async () => {
    const { relays, key, id } = await setup()
    const { host } = start(relays, { id, key })
    host.setToken('token-a')
    await until(() => states(host).join() === 'connected,connected')
    expect(host.relays).toEqual([
      { id: 'main', url: MAIN },
      { id: 'hk', url: REGION },
    ])
    expect(relays.relay(MAIN).hosts.get(id)?.account).toBe('account-a')
    expect(relays.relay(REGION).hosts.get(id)?.account).toBe('account-a')
  })

  it('signs in only with a token, renews it and signs out without it', async () => {
    const { relays, key, id } = await setup()
    const { host } = start(relays, { id, key })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(relays.relay(MAIN).sockets).toHaveLength(0)
    host.setToken('token-a')
    await until(() => states(host).every((state) => state === 'connected'))
    const control = relays.relay(MAIN).hosts.get(id)!.socket
    host.setToken('token-a2')
    await until(() => control.sent.some((sent) => sent === '{"type":"token","token":"token-a2"}'))
    host.setToken(null)
    await until(() => relays.relay(MAIN).hosts.size === 0 && relays.relay(REGION).hosts.size === 0)
    expect(states(host)).toEqual(['connecting', 'connecting'])
  })

  it('is refused with a key that is not its id', async () => {
    const { relays, id } = await setup()
    const other = await importRelayKey(await newRelaySeed())
    const { host } = start(relays, { id, key: other })
    host.setToken('token-a')
    await until(() => host.status.every((relay) => relay.connection.state === 'refused'))
    expect(host.status[0]!.connection).toEqual({ state: 'refused', error: 'unauthorized' })
  })

  it('hands on each device the relay joins, and its bytes pass both ways', async () => {
    const { relays, key, id } = await setup()
    const { host, accepted } = start(relays, { id, key })
    host.setToken('token-a')
    await until(() => states(host)[0] === 'connected')
    const result = await dialRelay({
      relays: [MAIN],
      id,
      token: 'token-a',
      openSocket: relays.openSocket,
      timeoutMs: 2000,
    })
    expect(result.kind).toBe('joined')
    await until(() => accepted.length === 1)
    expect(accepted[0]!.relay).toBe(MAIN)
    const device = (result as unknown as { socket: FakeSocket & WebSocket }).socket
    const hostEnd = accepted[0]!.socket as unknown as FakeSocket
    device.binaryType = 'arraybuffer'
    hostEnd.binaryType = 'arraybuffer'
    const heard: number[][] = []
    hostEnd.addEventListener('message', (event: MessageEvent) =>
      heard.push([...new Uint8Array(event.data as ArrayBuffer)]),
    )
    device.addEventListener('message', (event: MessageEvent) =>
      heard.push([...new Uint8Array(event.data as ArrayBuffer)]),
    )
    device.send(Uint8Array.of(1, 2, 3))
    hostEnd.send(Uint8Array.of(4, 5))
    await until(() => heard.length === 2)
    expect(heard).toContainEqual([1, 2, 3])
    expect(heard).toContainEqual([4, 5])
    host.setToken(null)
    await until(() => device.readyState === device.CLOSED)
  })

  it('stops in a conflict once replaced three times, until it retries', async () => {
    const { relays, key, id } = await setup()
    relays.relay(MAIN).regions = []
    const first = start(relays, { id, key }).host
    const second = start(relays, { id, key }).host
    first.setToken('token-a')
    second.setToken('token-a')
    await until(() => [first, second].some((host) => states(host)[0] === 'conflict'), 5000)
    const stuck = states(first)[0] === 'conflict' ? first : second
    const other = stuck === first ? second : first
    other.stop()
    stuck.retry()
    await until(() => states(stuck)[0] === 'connected')
  })

  it('signs in again after the relay drops it, and when pings go unanswered', async () => {
    const { relays, key, id } = await setup()
    relays.relay(MAIN).regions = []
    const { host } = start(relays, { id, key })
    host.setToken('token-a')
    await until(() => states(host)[0] === 'connected')
    relays.relay(MAIN).drop(id)
    await until(() => states(host)[0] === 'retrying')
    await until(() => states(host)[0] === 'connected')
    const signIns = relays.relay(MAIN).sockets.length
    relays.relay(MAIN).pongs = false
    await until(() => relays.relay(MAIN).sockets.length > signIns, 2000)
    expect(relays.relay(MAIN).sockets[signIns - 1]!.readyState).toBe(3)
  })

  it('keeps the regions it had when the main relay cannot list them, and backs off', async () => {
    const { relays, key, id } = await setup()
    relays.relay(MAIN).mode = 'down'
    const { host } = start(relays, { id, key, regions: [{ id: 'hk', url: REGION }] })
    host.setToken('token-a')
    await until(() => states(host)[1] === 'connected')
    expect(host.status[0]!.connection).toEqual({ state: 'retrying', error: 'unreachable' })
    relays.relay(MAIN).mode = 'up'
    await until(() => states(host)[0] === 'connected')
  })
})
