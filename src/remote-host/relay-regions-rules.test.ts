// The remote host's region rules against a main relay answered here: what it offers, its signed
// list, where each token may go, the regions a host signs in to with its devices' preferences, and
// the daily report.

import { createPrivateKey, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REGION_KEYS, PREFERENCE_TTL_MS } from '@shared/remote/relay-regions'
import vectors from '@shared/remote/relay-vectors.json'
import type { RelayRegion } from '@shared/remote/relay'

const answers = vi.hoisted(() => ({
  features: [] as string[],
  posted: [] as { url: string; headers: Record<string, string>; body: unknown }[],
  signedList: null as unknown,
  pingRtt: {} as Record<string, number>,
  pings: [] as string[],
  onPing: null as ((url: string) => Promise<void> | void) | null,
}))

vi.mock('./relay-net', () => ({
  jsonOf: (text: string) => JSON.parse(text) as unknown,
  relayRequest: async (
    url: string,
    request: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const { origin, pathname } = new URL(url)
    const reply = (status: number, body: unknown = null) => ({
      status,
      header: (name: string) => (name === 'etag' ? '"42"' : null),
      text: JSON.stringify(body),
    })
    if (pathname === '/v1') {
      return reply(200, { relay: 'kettu', protocol: 1, regions: [], features: answers.features })
    }
    if (pathname === '/v1/regions') return reply(200, answers.signedList ?? vectors.regions.signed)
    if (pathname === '/v1/ping') {
      answers.pings.push(origin)
      await answers.onPing?.(origin)
      return reply(204)
    }
    if (pathname === '/v1/reports' && request.method === 'POST') {
      answers.posted.push({ url, headers: request.headers ?? {}, body: JSON.parse(request.body!) })
      return reply(204)
    }
    return reply(404)
  },
}))

const { RemoteRegions } = await import('./relay-regions')

const MAIN = vectors.regions.main
const KEYS = { ...REGION_KEYS, [vectors.regions.key.id]: vectors.regions.key.publicKey }
const DEVICE = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const cleanups: (() => Promise<void> | void)[] = []
// The test key t1's private half, for lists the vectors do not hold.
const T1 = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(vectors.regions.key.seed, 'base64url'),
  ]),
  format: 'der',
  type: 'pkcs8',
})

function signedList(
  serial: number,
  customRegions?: {
    id: string
    name: string
    names?: Record<string, string>
    url: string
    pin?: string
    state: 'active' | 'probe'
  }[],
) {
  const body = { v: 1, serial, issuedAt: 1763300000000, place: { country: 'CN', asn: 4134 } }
  const list = customRegions ?? [{ id: 'main', name: 'Global', url: MAIN, state: 'active' }]
  const payload = Buffer.from(JSON.stringify({ ...body, regions: list, stun: [] })).toString(
    'base64url',
  )
  const text = Buffer.from(`${vectors.regions.context}${payload}`)
  return { key: 't1', payload, signature: sign(null, text, T1).toString('base64url') }
}

afterEach(async () => {
  vi.useRealTimers()
  answers.posted.length = 0
  answers.signedList = null
  answers.pingRtt = {}
  answers.pings.length = 0
  answers.onPing = null
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function regions(options: {
  features: string[]
  relayToken: string | null
  device?: boolean
  selectedRegions?: readonly string[] | null
  hostLegRtt?: (url: string) => number | null
  statusChanged?: () => void
  now?: () => number
}) {
  answers.features = options.features
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-region-rules-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const plans: (RelayRegion[] | null)[] = []
  let relayToken = options.relayToken
  const loaded = await RemoteRegions.load({
    userDataPath: dir,
    main: MAIN,
    app: 'desktop',
    keys: KEYS,
    device: options.device ?? false,
    accessToken: () => 'access-token',
    relayToken: () => relayToken,
    relayOn: () => true,
    plan: (plan) => plans.push(plan),
    hostChanged: () => {},
    timesChanged: () => {},
    ...(options.selectedRegions !== undefined ? { selectedRegions: options.selectedRegions } : {}),
    ...(options.hostLegRtt ? { hostLegRtt: options.hostLegRtt } : {}),
    ...(options.statusChanged ? { statusChanged: options.statusChanged } : {}),
    log: () => {},
    ...(options.now ? { now: options.now } : {}),
  })
  cleanups.push(() => loaded.stop())
  loaded.update()
  return { regions: loaded, plans, setRelayToken: (token: string | null) => (relayToken = token) }
}

describe('the remote host’s relay regions', () => {
  it('signs in by the region rules once it holds a relay token and the signed list', async () => {
    const t = await regions({ features: ['regions', 'relay-tokens'], relayToken: 'relay-token' })
    await expect.poll(() => t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1'])
    expect(t.regions.allowed([MAIN, 'https://hk-1.relay.kettu.sh'])).toHaveLength(2)

    // The access token alone: the main relay alone, whatever the list and GET /v1 name.
    t.setRelayToken(null)
    t.regions.update()
    expect(t.plans.at(-1)).toEqual([{ id: 'main', url: MAIN }])
    expect(t.regions.allowed([MAIN, 'https://hk-1.relay.kettu.sh'])).toEqual([MAIN])
    expect(t.regions.ranked('any')).toBeNull()
    expect(t.regions.preferMessage()).toBeNull()
  })

  it('gives the access token to any relay named while the main relay takes no relay token', async () => {
    const t = await regions({ features: ['hosts'], relayToken: null })
    // Until the main relay said, the main relay alone.
    expect(t.plans[0]).toEqual([{ id: 'main', url: MAIN }])
    await expect.poll(() => t.regions.allowed([MAIN, 'https://hk.relay.kettu.sh'])).toHaveLength(2)
    expect(t.plans.at(-1)).toBeNull()
    expect(t.regions.offered).toBe(false)
  })

  it("keeps a device's preferred regions from a list that verifies, for 30 days", async () => {
    let now = Date.now()
    const t = await regions({
      features: ['regions', 'relay-tokens'],
      relayToken: 'relay-token',
      now: () => now,
    })
    await expect.poll(() => t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1'])

    // A newer list the device holds; a region the rules refuse is never signed in to.
    await t.regions.preferred(DEVICE, {
      type: 'relay.prefer',
      regions: ['outside', 'sh-2'],
      list: vectors.regions.regionRules.signed,
    })
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1', 'sh-2'])
    expect(t.plans.at(-1)?.at(-1)?.pin).toBe(vectors.regions.list.regions[1]!.pin)

    // Neither a list that does not verify nor one older than the newest seen counts.
    await t.regions.preferred(OTHER, {
      type: 'relay.prefer',
      regions: ['hk-1'],
      list: vectors.regions.refused.badSignature,
    })
    await t.regions.preferred(OTHER, {
      type: 'relay.prefer',
      regions: ['hk-1'],
      list: vectors.regions.lowerSerial,
    })
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1', 'sh-2'])

    now += PREFERENCE_TTL_MS + 1
    await t.regions.preferred(OTHER, {
      type: 'relay.prefer',
      regions: ['main'],
      list: vectors.regions.regionRules.signed,
    })
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1'])
  })

  it('signs in to no region a device preferred from a list older than the newest seen', async () => {
    const t = await regions({ features: ['regions', 'relay-tokens'], relayToken: 'relay-token' })
    await expect.poll(() => t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1'])
    await t.regions.preferred(DEVICE, {
      type: 'relay.prefer',
      regions: ['sh-2'],
      list: vectors.regions.regionRules.signed,
    })
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1', 'sh-2'])
    // Another device holds a newer list, in which sh-2 may be gone: the older choice waits for
    // the device to send it again from its own newer list.
    await t.regions.preferred(OTHER, { type: 'relay.prefer', regions: [], list: signedList(44) })
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1'])
  })

  it('reports the day before once, with the relay token, to a main relay that takes reports', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    })
    vi.setSystemTime(new Date(2026, 10, 14, 12))
    const t = await regions({
      features: ['regions', 'relay-tokens', 'reports'],
      relayToken: 'relay-token',
    })
    t.regions.hostMeasured({ id: 'main', url: MAIN }, 180)
    t.regions.hostConnected({ id: 'main', url: MAIN }, true)
    vi.setSystemTime(new Date(2026, 10, 15, 9))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(answers.posted).toHaveLength(1)
    expect(answers.posted[0]).toMatchObject({
      url: `${MAIN}/v1/reports`,
      headers: { authorization: 'Bearer relay-token' },
      body: {
        v: 1,
        day: '2026-11-14',
        app: 'desktop',
        regions: [{ id: 'main', rttMedian: 180, rttP90: 180, connects: 1, failures: 0 }],
      },
    })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(answers.posted).toHaveLength(1)
  })

  it('sends no report without a relay token', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
    })
    vi.setSystemTime(new Date(2026, 10, 14, 12))
    const t = await regions({ features: ['regions', 'relay-tokens', 'reports'], relayToken: null })
    t.regions.hostMeasured({ id: 'main', url: MAIN }, 180)
    vi.setSystemTime(new Date(2026, 10, 15, 9))
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(answers.posted).toEqual([])
  })

  it('measures all regions in host-only (daemon) mode, replans by RTT, supports manual selection, and reports standby regions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date(2026, 10, 28, 12))

    const LA = 'https://la-1.relay.kettu.sh'
    const HK = 'https://hk-1.relay.kettu.sh'
    const GZ = 'https://gz-1.relay.kettu.sh'
    const SH = 'https://sh-1.relay.kettu.sh'
    const PROBE = 'https://probe-1.relay.kettu.sh'
    answers.signedList = signedList(10, [
      { id: 'main', name: 'Global', url: MAIN, state: 'active' },
      {
        id: 'la-1',
        name: 'Los Angeles',
        names: { en: 'Los Angeles', 'zh-CN': '洛杉矶' },
        url: LA,
        state: 'active',
      },
      {
        id: 'hk-1',
        name: 'Hong Kong',
        names: { en: 'Hong Kong', 'zh-CN': '香港' },
        url: HK,
        state: 'active',
      },
      {
        id: 'gz-1',
        name: 'Guangzhou',
        names: { en: 'Guangzhou', 'zh-CN': '广州' },
        url: GZ,
        state: 'active',
      },
      {
        id: 'sh-1',
        name: 'Shanghai',
        names: { en: 'Shanghai', 'zh-CN': '上海' },
        url: SH,
        state: 'active',
      },
      { id: 'probe-1', name: 'Probe', url: PROBE, state: 'probe' },
    ])

    const simulatedRtt: Record<string, number> = {
      [MAIN]: 220,
      [LA]: 210,
      [HK]: 150,
      [GZ]: 28,
      [SH]: 36,
      [PROBE]: 10,
    }
    answers.onPing = (origin) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, simulatedRtt[origin] ?? 50)
      })

    let statusChanges = 0
    const t = await regions({
      features: ['regions', 'relay-tokens'],
      relayToken: 'relay-token',
      device: false,
      statusChanged: () => {
        statusChanges++
      },
    })

    // Wait for async WebCrypto verification of the signed region list, then advance fake timers
    // so every concurrent RTT ping settles deterministically.
    for (let i = 0; i < 50 && !t.regions.source.list; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(t.regions.source.list).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)

    // Host probes regions even when device === false and replans to the lowest-RTT active regions.
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'gz-1', 'sh-1'])
    expect(statusChanges).toBeGreaterThan(0)

    // availableRegions merges live connected states/RTTs with standby regions and omits probes.
    const available = t.regions.availableRegions(
      [
        { id: 'main', url: MAIN, connection: { state: 'connected' }, rtt: 224 },
        { id: 'gz-1', url: GZ, name: 'Guangzhou', connection: { state: 'connected' }, rtt: 30 },
        { id: 'sh-1', url: SH, name: 'Shanghai', connection: { state: 'connecting' } },
      ],
      [
        { id: 'main', url: MAIN, hostRtt: 224 },
        { id: 'gz-1', url: GZ, hostRtt: 30 },
      ],
    )
    expect(available.map((r) => ({ id: r.id, state: r.connection.state, rtt: r.rtt }))).toEqual([
      { id: 'main', state: 'connected', rtt: 224 },
      { id: 'la-1', state: 'standby', rtt: 210 },
      { id: 'hk-1', state: 'standby', rtt: 150 },
      { id: 'gz-1', state: 'connected', rtt: 30 },
      { id: 'sh-1', state: 'connecting', rtt: 36 },
    ])
    expect(available.find((r) => r.id === 'gz-1')?.names).toEqual({
      en: 'Guangzhou',
      'zh-CN': '广州',
    })

    // Manual selection overrides automatic RTT picks and keeps main as baseline.
    t.regions.setSelectedRegions(['hk-1'])
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1'])

    // Clearing manual selection returns to automatic mode.
    t.regions.setSelectedRegions(null)
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'gz-1', 'sh-1'])

    // measureNow forces a fresh measurement pass and replans when latencies shift.
    simulatedRtt[HK] = 15
    simulatedRtt[GZ] = 120
    const beforeStatus = statusChanges
    const measuring = t.regions.measureNow()
    await vi.advanceTimersByTimeAsync(1_000)
    await measuring
    expect(statusChanges).toBeGreaterThan(beforeStatus)
    expect(t.plans.at(-1)?.map((r) => r.id)).toEqual(['main', 'hk-1', 'sh-1'])
  })
})
