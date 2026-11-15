// The remote host's region rules against a main relay answered here: what it offers, its signed
// list, where each token may go, the regions a host signs in to with its devices' preferences, and
// the daily report.

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
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  answers.posted.length = 0
  vi.useRealTimers()
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

    // The access token alone: back to the main relay's own regions, which are then only itself.
    t.setRelayToken(null)
    t.regions.update()
    expect(t.plans.at(-1)).toBeNull()
    expect(t.regions.allowed([MAIN, 'https://hk-1.relay.kettu.sh'])).toEqual([MAIN])
    expect(t.regions.ranked('any')).toBeNull()
    expect(t.regions.preferMessage()).toBeNull()
  })

  it('gives the access token to any relay named while the main relay takes no relay token', async () => {
    const t = await regions({ features: ['hosts'], relayToken: null })
    await expect.poll(() => t.regions.allowed([MAIN, 'https://hk.relay.kettu.sh'])).toHaveLength(2)
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
