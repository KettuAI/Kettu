import { describe, expect, it } from 'vitest'
import type { ArtifactContentResult } from '@shared/host-control'
import { ContentCache } from './content-cache'

const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

function found(version: number, strict = false): ArtifactContentResult {
  return { kind: 'found', version, title: 'Page', key: 'k', strict, files: [], type: null }
}

/** A host whose answers wait until `answer` is called, counting what it was asked. */
function slowHost() {
  const asked: (number | null)[] = []
  const waiting: ((result: ArtifactContentResult) => void)[] = []
  return {
    asked,
    ask: (_id: string, version: number | null) => {
      asked.push(version)
      return new Promise<ArtifactContentResult>((resolve) => waiting.push(resolve))
    },
    answer: (result: ArtifactContentResult) => waiting.shift()!(result),
  }
}

describe('ContentCache', () => {
  it('asks the host once for the requests of one version', async () => {
    const host = slowHost()
    const cache = new ContentCache(host.ask)
    const requests = Array.from({ length: 50 }, () => cache.get(ID, 2))
    host.answer(found(2))
    const results = await Promise.all(requests)
    expect(host.asked).toEqual([2])
    expect(results.every((r) => r.kind === 'found' && r.version === 2)).toBe(true)
    await cache.get(ID, 2)
    expect(host.asked).toEqual([2])
  })

  it('keeps versions and the latest apart', async () => {
    const host = slowHost()
    const cache = new ContentCache(host.ask)
    const latest = cache.get(ID, null)
    const first = cache.get(ID, 1)
    host.answer(found(3))
    host.answer(found(1))
    expect(await latest).toMatchObject({ version: 3 })
    expect(await first).toMatchObject({ version: 1 })
    expect(host.asked).toEqual([null, 1])
  })

  it('asks again after a change, so a new declaration or a deletion shows at once', async () => {
    const host = slowHost()
    const cache = new ContentCache(host.ask)
    const before = cache.get(ID, 2)
    host.answer(found(2))
    await before
    cache.clear()
    const after = cache.get(ID, 2)
    host.answer({ kind: 'not_found' })
    expect(await after).toEqual({ kind: 'not_found' })
    expect(host.asked).toEqual([2, 2])
  })

  it('never keeps an answer asked for before a change', async () => {
    const host = slowHost()
    const cache = new ContentCache(host.ask)
    const stale = cache.get(ID, 2)
    cache.clear()
    host.answer(found(2, false))
    expect(await stale).toMatchObject({ strict: false })
    const fresh = cache.get(ID, 2)
    host.answer(found(2, true))
    expect(await fresh).toMatchObject({ strict: true })
    expect(host.asked).toEqual([2, 2])
  })

  it('keeps no failure, so the next request asks again', async () => {
    const host = slowHost()
    const cache = new ContentCache(host.ask)
    const failed = cache.get(ID, 2)
    host.answer({ kind: 'failed' })
    expect(await failed).toEqual({ kind: 'failed' })
    const missing = cache.get(ID, 2)
    host.answer({ kind: 'not_found' })
    expect(await missing).toEqual({ kind: 'not_found' })
    const again = cache.get(ID, 2)
    host.answer(found(2))
    expect(await again).toMatchObject({ kind: 'found' })
    expect(host.asked).toEqual([2, 2, 2])
  })

  it('keeps only the most recent versions', async () => {
    const host = slowHost()
    const cache = new ContentCache(host.ask, 2)
    for (const version of [1, 2, 3]) {
      const got = cache.get(ID, version)
      host.answer(found(version))
      await got
    }
    const third = cache.get(ID, 3)
    expect(await third).toMatchObject({ version: 3 })
    const first = cache.get(ID, 1)
    host.answer(found(1))
    await first
    expect(host.asked).toEqual([1, 2, 3, 1])
  })
})
