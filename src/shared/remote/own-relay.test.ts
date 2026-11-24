// A relay the owner runs: what an address and the printed link may be, the checks before a host
// switches to it, and who it lets in: the host with the access key, devices with no token at all,
// so neither the key nor an account's token ever reaches a device or that relay.

import { describe, expect, it } from 'vitest'
import { FakeRelays } from './fake-relay'
import {
  checkOwnRelay,
  isLoopbackOrigin,
  ownRelayProblem,
  parseRelayLink,
  relayChoiceInit,
  relayLink,
  RelayReachError,
} from './own-relay'
import {
  ACCESS_KEY_FEATURE,
  connectMessage,
  importRelayKey,
  isOwnRelay,
  newRelaySeed,
  parseHostRelay,
  parseRelayInfo,
  relayHostId,
} from './relay'
import { dialRelay } from './relay-device'
import { RelayHost } from './relay-host'
import vectors from './relay-vectors.json'

const KEY = vectors.ownRelay.accessKey
const RELAY = 'https://relay.example.com'
const PIN = vectors.ownRelay.pin

async function signer() {
  const seed = await newRelaySeed()
  const key = await importRelayKey(seed)
  return { key, id: await relayHostId(key.publicKey) }
}

describe('the owner’s own relay', () => {
  it('reads the link it prints, and an address alone', () => {
    expect(parseRelayLink(`${RELAY}#key=${KEY}`)).toEqual({ url: RELAY, key: KEY, pin: null })
    expect(parseRelayLink(` ${RELAY}/#key=${KEY}&pin=${PIN} `)).toEqual({
      url: RELAY,
      key: KEY,
      pin: PIN,
    })
    expect(parseRelayLink('http://127.0.0.1:8798')).toEqual({
      url: 'http://127.0.0.1:8798',
      key: null,
      pin: null,
    })
    expect(parseRelayLink(relayLink({ url: RELAY, key: KEY, pin: PIN }))).toEqual({
      url: RELAY,
      key: KEY,
      pin: PIN,
    })
    for (const text of vectors.ownRelay.invalidLinks) expect(parseRelayLink(text)).toBeNull()
  })

  it('takes no Kettu address and plain http only on this computer', () => {
    expect(ownRelayProblem(RELAY)).toBeNull()
    expect(ownRelayProblem('http://127.0.0.1:8798')).toBeNull()
    expect(ownRelayProblem('http://[::1]:8798')).toBeNull()
    expect(ownRelayProblem('http://localhost:8798')).toBeNull()
    expect(ownRelayProblem('https://relay.kettu.sh')).toBe('kettu')
    expect(ownRelayProblem('https://hk-1.relay.kettu.sh')).toBe('kettu')
    expect(ownRelayProblem('https://kettu.sh')).toBe('kettu')
    expect(ownRelayProblem('http://203.0.113.7:8080')).toBe('http')
    expect(ownRelayProblem('http://relay.example.com')).toBe('http')
    expect(ownRelayProblem(`${RELAY}/path`)).toBe('address')
    expect(ownRelayProblem('ftp://relay.example.com')).toBe('address')
    expect(isLoopbackOrigin('http://127.1.2.3:80')).toBe(true)
    expect(isLoopbackOrigin('http://127.example.com')).toBe(false)
  })

  it('reads the answer of a relay with an access key and no regions', () => {
    const info = parseRelayInfo(vectors.ownRelay.info)
    expect(info?.features).toContain(ACCESS_KEY_FEATURE)
    expect(info?.regions).toEqual([])
    expect(info?.version).toBe('dev')
  })

  it('keeps a pin only for an https relay, and tells it from the Kettu relay', () => {
    const id = 'a'.repeat(26)
    expect(parseHostRelay({ id, urls: [RELAY], pin: PIN })?.pin).toBe(PIN)
    expect(parseHostRelay({ id, urls: ['http://127.0.0.1:8798'], pin: PIN })?.pin).toBeUndefined()
    expect(isOwnRelay({ id, urls: [RELAY] }, 'https://relay.kettu.sh')).toBe(true)
    expect(isOwnRelay({ id, urls: ['https://relay.kettu.sh'] }, 'https://relay.kettu.sh')).toBe(
      false,
    )
  })

  it('sends a device’s connect with no token at all', () => {
    expect(connectMessage(null)).toEqual({ type: 'connect', features: ['drain'] })
    expect('token' in connectMessage(null)).toBe(false)
  })

  it('gives the host its key only while the own relay is chosen', () => {
    const own = { url: RELAY, pin: null }
    expect(relayChoiceInit({ relay: 'own', ownRelay: own }, false, KEY)).toEqual({
      enabled: false,
      own: { url: RELAY, pin: null, key: KEY },
    })
    expect(relayChoiceInit({ relay: 'own', ownRelay: own }, true, null).own).toBeNull()
    expect(relayChoiceInit({ relay: 'kettu', ownRelay: own }, true, KEY)).toEqual({
      enabled: true,
      own: null,
    })
    // Local mode: the Kettu relay is not used even while chosen.
    expect(relayChoiceInit({ relay: 'kettu', ownRelay: null }, false, KEY).enabled).toBe(false)
  })
})

describe('checking a relay before switching to it', () => {
  async function check(relays: FakeRelays, options: { url?: string; key?: string | null } = {}) {
    return checkOwnRelay({
      url: options.url ?? RELAY,
      key: options.key === undefined ? KEY : options.key,
      pin: null,
      fetchInfo: relays.fetchInfo,
      openSocket: relays.openSocket,
      timeoutMs: 2000,
    })
  }

  it('passes a relay that takes the key', async () => {
    const relays = new FakeRelays()
    relays.relay(RELAY).useAccessKey(KEY)
    expect(await check(relays)).toEqual({ ok: true, url: RELAY, pin: null, version: '0.1.0' })
    // The check signs in and leaves at once.
    await expect.poll(() => relays.relay(RELAY).hosts.size).toBe(0)
  })

  it('leaves the host’s own connection to the relay alone', async () => {
    const relays = new FakeRelays()
    const server = relays.relay(RELAY)
    server.useAccessKey(KEY)
    const { key, id } = await signer()
    const host = new RelayHost({
      main: RELAY,
      id,
      key,
      own: { id: 'own', url: RELAY },
      openSocket: relays.openSocket,
      fetchInfo: () => Promise.reject(new Error('An own relay lists no regions')),
      accepted: () => {},
      changed: () => {},
      log: () => {},
    })
    host.start()
    host.setToken(KEY)
    await expect.poll(() => host.status[0]?.connection.state).toBe('connected')
    expect((await check(relays)).ok).toBe(true)
    expect(host.status[0]?.connection.state).toBe('connected')
    expect(server.hosts.get(id)?.socket).toBeDefined()
    host.stop()
  })

  it('says which check failed', async () => {
    const relays = new FakeRelays()
    relays.relay(RELAY).useAccessKey(KEY)
    expect(await check(relays, { key: `${KEY}x` })).toEqual({ ok: false, problem: 'key_refused' })
    expect(await check(relays, { key: null })).toEqual({ ok: false, problem: 'key' })
    expect(await check(relays, { url: 'https://relay.kettu.sh' })).toEqual({
      ok: false,
      problem: 'kettu',
    })

    const kettus = new FakeRelays()
    expect(await check(kettus)).toEqual({ ok: false, problem: 'no_access_key' })

    const down = new FakeRelays()
    down.relay(RELAY).mode = 'down'
    expect(await check(down)).toEqual({ ok: false, problem: 'unreachable' })

    const base = { url: RELAY, key: KEY, pin: null, openSocket: relays.openSocket }
    expect(
      await checkOwnRelay({
        ...base,
        fetchInfo: () => Promise.reject(new RelayReachError('certificate')),
      }),
    ).toEqual({ ok: false, problem: 'certificate' })
    expect(await checkOwnRelay({ ...base, fetchInfo: async () => ({ ok: true }) })).toEqual({
      ok: false,
      problem: 'not_kettu',
    })
    expect(
      await checkOwnRelay({
        ...base,
        fetchInfo: async () => ({ relay: 'kettu', protocol: 2, features: [ACCESS_KEY_FEATURE] }),
      }),
    ).toEqual({ ok: false, problem: 'protocol' })
  })
})

describe('admission to the owner’s relay', () => {
  it('signs the host in with the key and joins a device that sends no token', async () => {
    const relays = new FakeRelays()
    const server = relays.relay(RELAY)
    server.useAccessKey(KEY)
    const { key, id } = await signer()
    const accepted: string[] = []
    const host = new RelayHost({
      main: RELAY,
      id,
      key,
      own: { id: 'own', url: RELAY },
      openSocket: relays.openSocket,
      fetchInfo: () => Promise.reject(new Error('An own relay lists no regions')),
      accepted: (socket) => accepted.push(socket.url),
      changed: () => {},
      log: () => {},
    })
    host.start()
    host.setToken(KEY)
    await expect.poll(() => server.hosts.has(id)).toBe(true)

    const result = await dialRelay({
      relays: [RELAY],
      id,
      token: null,
      openSocket: relays.openSocket,
      timeoutMs: 2000,
    })
    expect(result.kind).toBe('joined')
    expect(server.deviceTokens).toEqual([null])
    expect(accepted).toHaveLength(1)
    host.stop()
  })

  it('refuses a host with another key', async () => {
    const relays = new FakeRelays()
    const server = relays.relay(RELAY)
    server.useAccessKey(KEY)
    const { key, id } = await signer()
    const host = new RelayHost({
      main: RELAY,
      id,
      key,
      own: { id: 'own', url: RELAY },
      openSocket: relays.openSocket,
      fetchInfo: () => Promise.reject(new Error('An own relay lists no regions')),
      accepted: () => {},
      changed: () => {},
      log: () => {},
    })
    host.start()
    host.setToken(`${KEY}x`)
    await expect
      .poll(() => host.status[0]?.connection)
      .toEqual({ state: 'refused', error: 'unauthorized' })
    expect(server.hosts.has(id)).toBe(false)
    host.stop()
  })
})
