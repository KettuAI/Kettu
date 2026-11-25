import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MarketIcon, MarketResults } from '@shared/market-publish'
import { jpeg, png } from '../plugins/icon-fixture'
import { MarketIcons } from './icons'

const URL_PATH = '/api/v1/marketplace/listings/abcdefgh23/versions/1.0.0/icon'
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-icons-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function service(answer: () => MarketResults['icon'] | Promise<MarketResults['icon']>) {
  const calls: string[] = []
  const logs: string[] = []
  let now = 0
  const icons = new MarketIcons({
    dir,
    log: (_level, message) => logs.push(message),
    call: async (call) => {
      calls.push(call.url)
      return answer()
    },
    now: () => now,
  })
  return { icons, calls, logs, pass: (ms: number) => (now += ms) }
}

const iconOf = (data: Buffer, type: MarketIcon['type'] = 'image/png'): MarketIcon => ({
  url: URL_PATH,
  sha256: hash(data),
  type,
})
const answer = (data: Buffer, sha256: string | null = hash(data)) => ({
  data: data.toString('base64'),
  sha256,
})

describe('MarketIcons', () => {
  it('fetches an icon once by its SHA-256 and hands it over as a data URL', async () => {
    const bytes = png(512)
    const { icons, calls } = service(() => answer(bytes))
    const url = `data:image/png;base64,${bytes.toString('base64')}`
    const [a, b] = await Promise.all([icons.dataUrl(iconOf(bytes)), icons.dataUrl(iconOf(bytes))])
    expect([a, b]).toEqual([url, url])
    expect(await icons.dataUrl(iconOf(bytes))).toBe(url)
    expect(calls).toEqual([URL_PATH])
  })

  it('keeps it on disk, so a later host reads it without fetching', async () => {
    const bytes = png(512)
    await service(() => answer(bytes)).icons.dataUrl(iconOf(bytes))
    expect(await readdir(dir)).toEqual([hash(bytes)])
    const later = service(() => {
      throw new Error('fetched again')
    })
    expect(await later.icons.dataUrl(iconOf(bytes))).toBe(
      `data:image/png;base64,${bytes.toString('base64')}`,
    )
    expect(later.calls).toEqual([])
  })

  it('shows none whose bytes are not the SHA-256 the listing gives or the service sent', async () => {
    const bytes = png(512)
    const other = png(600)
    const swapped = service(() => answer(other))
    expect(await swapped.icons.dataUrl(iconOf(bytes))).toBeNull()
    const sent = service(() => answer(bytes, 'f'.repeat(64)))
    expect(await sent.icons.dataUrl(iconOf(bytes))).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('shows none of another type, size or shape than an icon may have, and keeps none', async () => {
    for (const [bytes, type] of [
      [jpeg(512), 'image/png'],
      [png(128), 'image/png'],
      [png(512, 300), 'image/png'],
      [Buffer.from('<svg onload="x()"/>'), 'image/png'],
    ] as const) {
      const { icons, logs } = service(() => answer(bytes))
      expect(await icons.dataUrl(iconOf(bytes, type))).toBeNull()
      expect(logs).toHaveLength(1)
    }
    expect(await readdir(dir)).toEqual([])
  })

  it('does not ask again for one that failed until a while has passed', async () => {
    const bytes = png(512)
    let fail = true
    const { icons, calls, pass } = service(() => {
      if (fail) throw new Error('offline')
      return answer(bytes)
    })
    expect(await icons.dataUrl(iconOf(bytes))).toBeNull()
    expect(await icons.dataUrl(iconOf(bytes))).toBeNull()
    expect(calls).toHaveLength(1)
    fail = false
    pass(5 * 60_000 + 1)
    expect(await icons.dataUrl(iconOf(bytes))).not.toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('asks nothing for a listing without an icon or with a hash that is none', async () => {
    const { icons, calls } = service(() => answer(png(512)))
    expect(await icons.dataUrl(null)).toBeNull()
    expect(await icons.dataUrl(undefined)).toBeNull()
    expect(await icons.dataUrl({ url: URL_PATH, sha256: '../x', type: 'image/png' })).toBeNull()
    expect(calls).toEqual([])
  })
})
