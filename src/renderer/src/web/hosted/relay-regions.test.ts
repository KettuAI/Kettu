// HostedRelay client-side relay preference: localStorage persistence, endpoint ordering with
// token isolation for own relays, relay.own handling (filtering pinned IP-only relays), speed
// testing, snapshot generation, and change notifications.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostLink, LinkState } from '@shared/remote/link'
import { REGIONS_CHANNEL_FEATURE, REGION_KEYS } from '@shared/remote/relay-regions'
import vectors from '@shared/remote/relay-vectors.json'
import type { HostedAccount } from './account'
import { HostedRelay, RELAY_PREFERENCE_STORAGE_KEY } from './relay-regions'

const MAIN = vectors.regions.main
const HK = 'https://hk-1.relay.kettu.sh'
const SH_PINNED = 'https://203.0.113.7:7443'
const OWN_DOMAIN = 'https://own.example.com'
const OWN_IP = 'https://203.0.113.9:8443'
const PIN = vectors.regions.list.regions[1]!.pin!
const KEYS = { ...REGION_KEYS, [vectors.regions.key.id]: vectors.regions.key.publicKey }

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

function fakeLink() {
  let state: LinkState = { kind: 'connecting' }
  const messageListeners = new Set<(message: Record<string, unknown>) => void>()
  const stateListeners = new Set<(state: LinkState) => void>()
  const sent: Record<string, unknown>[] = []
  const link = {
    get state() {
      return state
    },
    onMessage: (listener: (message: Record<string, unknown>) => void) => {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
    onState: (listener: (s: LinkState) => void) => {
      stateListeners.add(listener)
      listener(state)
      return () => stateListeners.delete(listener)
    },
    send: (message: Record<string, unknown>) => {
      sent.push(message)
    },
  } as unknown as HostLink
  return {
    link,
    sent,
    connect: () => {
      state = {
        kind: 'connected',
        welcome: {
          type: 'welcome',
          protocol: 3,
          role: 'owner',
          host: { name: 'Studio', platform: 'darwin', version: '1.0.0' },
          device: { id: 'dev-1', name: 'Browser' },
          addresses: [],
          terminal: false,
          features: [REGIONS_CHANNEL_FEATURE],
        },
      }
      for (const listener of stateListeners) listener(state)
    },
    emit: (message: Record<string, unknown>) => {
      for (const listener of messageListeners) listener(message)
    },
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockNetwork(
  options: {
    pingDelays?: Record<string, number>
    features?: string[]
    relayToken?: string
  } = {},
) {
  const pinged: string[] = []
  const pingDelays = options.pingDelays ?? {}
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const { origin, pathname } = new URL(url)
    if (pathname === '/v1') {
      return new Response(
        JSON.stringify({
          relay: 'kettu',
          protocol: 1,
          regions: [],
          features: options.features ?? ['regions', 'relay-tokens'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (pathname === '/v1/regions') {
      return new Response(JSON.stringify(vectors.regions.signed), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"42"' },
      })
    }
    if (pathname === '/v1/ping') {
      pinged.push(origin)
      const delay = pingDelays[origin] ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      return new Response(null, { status: 204 })
    }
    if (pathname === '/api/v1/relay/token') {
      return new Response(
        JSON.stringify({
          token: options.relayToken ?? 'relay-token',
          expiresAt: Date.now() + 3_600_000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
  return { pinged }
}

describe('HostedRelay preference persistence, routing, and relay.own handling', () => {
  const fakeAccount = {
    accessToken: async () => 'account-access-token',
  } as unknown as HostedAccount

  it('loads and persists RelayPreference safely in storage and handles storage errors', () => {
    const storage = memoryStorage({ [RELAY_PREFERENCE_STORAGE_KEY]: 'official:hk-1' })
    const relay = new HostedRelay(fakeAccount, MAIN, 'https://account.test', KEYS, storage)
    expect(relay.preference()).toEqual({ kind: 'official', id: 'hk-1' })

    let notifications = 0
    relay.onChanged(() => notifications++)
    relay.setPreference('own:https://own.example.com/')
    expect(relay.preference()).toEqual({ kind: 'own', origin: OWN_DOMAIN })
    expect(storage.data.get(RELAY_PREFERENCE_STORAGE_KEY)).toBe(`own:${OWN_DOMAIN}`)
    expect(notifications).toBe(1)

    // Throwing storage never breaks initialization or updates.
    const brokenStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    const safe = new HostedRelay(fakeAccount, MAIN, 'https://account.test', KEYS, brokenStorage)
    expect(safe.preference()).toEqual({ kind: 'automatic' })
    expect(() => safe.setPreference('official:main')).not.toThrow()
    expect(safe.preference()).toEqual({ kind: 'official', id: 'main' })
  })

  it('filters pinned IP-only own relays, supports domain own relays with token: null, and orders endpoints by preference', async () => {
    const { pinged } = mockNetwork()
    const storage = memoryStorage()
    const relay = new HostedRelay(fakeAccount, MAIN, 'https://account.test', KEYS, storage)

    // Fetch relay token and signed region list.
    expect(await relay.token()).toBe('relay-token')
    await relay.refreshSpeeds()
    expect(relay.source.list).not.toBeNull()

    const { link, sent, connect, emit } = fakeLink()
    relay.attach(link, { id: 'host-1', urls: [MAIN, HK] })
    connect()

    // Host announces its active official regions (pinned SH is dropped in browser).
    emit({
      type: 'relay.regions',
      list: vectors.regions.signed,
      regions: [
        { id: 'main', rtt: 150 },
        { id: 'hk-1', rtt: 20 },
        { id: 'sh-1', rtt: 5 },
      ],
    })
    await expect
      .poll(() => relay.devices.ranked('host-1')?.map((r) => r.id))
      .toEqual(['hk-1', 'main'])

    // Pinned IP-only own relay is ignored by browser.
    emit({
      type: 'relay.own',
      own: { url: OWN_IP, pin: PIN, rtt: 5 },
    })
    expect(relay.snapshot(HK).own).toEqual([])

    // Standard HTTPS domain own relay is accepted and probed without token.
    emit({
      type: 'relay.own',
      own: { url: OWN_DOMAIN, rtt: 5 },
    })
    await expect.poll(() => pinged.includes(OWN_DOMAIN)).toBe(true)

    // Snapshot lists main + non-pinned active official regions + domain own relay, with inUse accurate.
    const snap = relay.snapshot(HK)
    expect(snap.preference).toBe('auto')
    expect(snap.official.map((n) => ({ id: n.id, inUse: n.inUse }))).toEqual([
      { id: 'main', inUse: false },
      { id: 'hk-1', inUse: true },
    ])
    expect(snap.official.some((n) => n.url === SH_PINNED)).toBe(false)
    expect(snap.own).toEqual([{ origin: OWN_DOMAIN, rtt: expect.any(Number), inUse: false }])

    // Manual own preference places own relay first with token: null (credential isolation).
    relay.setPreference(`own:${OWN_DOMAIN}`)
    expect(relay.endpoints('host-1', [MAIN, HK])).toEqual([
      { url: OWN_DOMAIN, token: null },
      { url: HK },
      { url: MAIN },
    ])
    expect(relay.preferredRouteKey('host-1', [MAIN, HK])).toBe(`relay ${OWN_DOMAIN}`)

    // Manual official:main places MAIN first ahead of HK and keeps own as fallback.
    relay.setPreference('official:main')
    expect(relay.endpoints('host-1', [MAIN, HK])).toEqual([
      { url: MAIN },
      { url: HK },
      { url: OWN_DOMAIN, token: null },
    ])
    expect(relay.preferredRouteKey('host-1', [MAIN, HK])).toBe(`relay ${MAIN}`)

    // Manual official:hk-1 pushes updated relay.prefer immediately to connected links.
    const sentBefore = sent.length
    relay.setPreference('official:hk-1')
    expect(sent.length).toBeGreaterThan(sentBefore)
    expect(sent.at(-1)).toMatchObject({
      type: 'relay.prefer',
      regions: ['hk-1', 'main'],
    })

    // refreshSpeeds re-probes both official regions and domain own relay.
    pinged.length = 0
    await relay.refreshSpeeds()
    expect(pinged).toContain(MAIN)
    expect(pinged).toContain(HK)
    expect(pinged).toContain(OWN_DOMAIN)
    expect(pinged).not.toContain(SH_PINNED)

    // Clearing own relay via relay.own removes it from snapshot and endpoints.
    emit({ type: 'relay.own', own: null })
    expect(relay.snapshot(HK).own).toEqual([])
  })
})
