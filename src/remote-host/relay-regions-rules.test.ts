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
}))

vi.mock('./relay-net', () => ({
  jsonOf: (text: string) => JSON.parse(text) as unknown,
  relayRequest: async (
    url: string,
    request: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const { pathname } = new URL(url)
    const reply = (status: number, body: unknown = null) => ({
      status,
      header: (name: string) => (name === 'etag' ? '"42"' : null),
      text: JSON.stringify(body),
    })
    if (pathname === '/v1') {
      return reply(200, { relay: 'kettu', protocol: 1, regions: [], features: answers.features })
    }
    if (pathname === '/v1/regions') return reply(200, vectors.regions.signed)
    if (pathname === '/v1/ping') return reply(204)
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

function signedList(serial: number) {
  const body = { v: 1, serial, issuedAt: 1763300000000, place: { country: 'CN', asn: 4134 } }
  const regions = [{ id: 'main', name: 'Global', url: MAIN, state: 'active' }]
  const payload = Buffer.from(JSON.stringify({ ...body, regions, stun: [] })).toString('base64url')
  const text = Buffer.from(`${vectors.regions.context}${payload}`)
  return { key: 't1', payload, signature: sign(null, text, T1).toString('base64url') }
}

afterEach(async () => {
  vi.useRealTimers()
  answers.posted.length = 0
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function regions(options: {
  features: string[]
  relayToken: string | null
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
    device: false,
    accessToken: () => 'access-token',
    relayToken: () => relayToken,
    relayOn: () => true,
    plan: (plan) => plans.push(plan),
    hostChanged: () => {},
    timesChanged: () => {},
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
})
