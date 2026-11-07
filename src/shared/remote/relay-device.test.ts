import { describe, expect, it } from 'vitest'
import { FakeRelays, type FakeSocket } from './fake-relay'
import { importRelayKey, newRelaySeed, relayHostId } from './relay'
import { dialRelay } from './relay-device'
import { RelayHost } from './relay-host'

const MAIN = 'https://relay.kettu.test'
const REGION = 'https://hk.relay.kettu.test'

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function online(relays: FakeRelays, account = 'token-a') {
  const key = await importRelayKey(await newRelaySeed())
  const id = await relayHostId(key.publicKey)
  const accepted: WebSocket[] = []
  const host = new RelayHost({
    main: MAIN,
    id,
    key,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) => accepted.push(socket),
    changed: () => {},
    log: () => {},
  })
  host.start()
  host.setToken(account)
  await until(
    () => host.status.length === 2 && host.status.every((r) => r.connection.state === 'connected'),
  )
  return { host, id, accepted }
}

function setup(): FakeRelays {
  const relays = new FakeRelays()
  relays.accounts.set('token-a', 'account-a')
  relays.accounts.set('token-b', 'account-b')
  relays.relay(MAIN).regions = [{ id: 'hk', url: REGION }]
  return relays
}

const dial = (relays: FakeRelays, id: string, token = 'token-a', staggerMs = 2000) =>
  dialRelay({
    relays: [MAIN, REGION],
    id,
    token,
    openSocket: relays.openSocket,
    timeoutMs: 5000,
    staggerMs,
  })

describe('a device on the relay', () => {
  it('joins through the first relay', async () => {
    const relays = setup()
    const { host, id, accepted } = await online(relays)
    const result = await dial(relays, id)
    expect(result).toMatchObject({ kind: 'joined', relay: MAIN })
    await until(() => accepted.length === 1)
    // The second relay was not asked.
    expect(relays.relay(REGION).sockets.filter((s) => s.url.endsWith('/connect'))).toHaveLength(0)
    host.stop()
  })

  it('asks the next relay when the first is silent, and keeps the one that joins', async () => {
    const relays = setup()
    const { host, id } = await online(relays)
    relays.relay(MAIN).mode = 'silent'
    const started = Date.now()
    const result = await dial(relays, id, 'token-a', 100)
    expect(result).toMatchObject({ kind: 'joined', relay: REGION })
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    const silent = relays.relay(MAIN).sockets.at(-1)!
    expect(silent.readyState).toBe(silent.CLOSED)
    host.stop()
  })

  it('says the host is offline when every relay says so, and unreachable when none answers', async () => {
    const relays = setup()
    const id = await relayHostId((await importRelayKey(await newRelaySeed())).publicKey)
    expect(await dial(relays, id)).toEqual({ kind: 'offline' })
    relays.relay(MAIN).mode = 'down'
    relays.relay(REGION).mode = 'down'
    expect(await dial(relays, id)).toEqual({ kind: 'unreachable' })
    relays.relay(REGION).mode = 'up'
    expect(await dial(relays, id)).toEqual({ kind: 'offline' })
  })

  it("is refused with another account than the host's", async () => {
    const relays = setup()
    const { host, id } = await online(relays)
    expect(await dial(relays, id, 'token-b')).toEqual({ kind: 'forbidden' })
    expect(await dial(relays, id, 'not-a-token')).toEqual({ kind: 'forbidden' })
    host.stop()
  })

  it('closes either end of a joined pair with the other', async () => {
    const relays = setup()
    const { host, id, accepted } = await online(relays)
    const first = (await dial(relays, id)) as unknown as { socket: FakeSocket & WebSocket }
    await until(() => accepted.length === 1)
    first.socket.close()
    const hostEnd = accepted[0] as unknown as FakeSocket
    await until(() => hostEnd.readyState === hostEnd.CLOSED)
    const second = (await dial(relays, id)) as unknown as { socket: FakeSocket & WebSocket }
    await until(() => accepted.length === 2)
    accepted[1]!.close()
    await until(() => second.socket.readyState === second.socket.CLOSED)
    host.stop()
  })
})
