import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_STORAGE_LIMITS } from '@shared/plugins'
import { tempFolder } from '../testing/temp'
import { PluginStorage, STORAGE_FILE } from './storage'

let root: string
const log = vi.fn()

function storage(): PluginStorage {
  return new PluginStorage((id) => path.join(root, id), log)
}

beforeEach(async () => {
  log.mockClear()
  root = await tempFolder('kettu-plugin-storage-')
  await mkdir(path.join(root, 'a'))
  await mkdir(path.join(root, 'b'))
})

describe("a plugin's own storage", () => {
  it('keeps any JSON value by key, per plugin, and gives it back after a restart', async () => {
    const first = storage()
    await first.set('a', 'count', { n: 2, tags: ['x'] })
    await first.set('a', 'name', 'Ada')
    await first.set('b', 'name', 'Bob')
    expect(await first.get('a', 'count')).toEqual({ n: 2, tags: ['x'] })
    expect(await first.get('a', 'missing')).toBeNull()
    expect(await first.keys('a')).toEqual(['count', 'name'])
    const again = storage()
    expect(await again.get('a', 'name')).toBe('Ada')
    expect(await again.get('b', 'name')).toBe('Bob')
  })

  it('deletes a key', async () => {
    const kept = storage()
    await kept.set('a', 'one', 1)
    await kept.set('a', 'two', 2)
    await kept.delete('a', 'one')
    expect(await storage().keys('a')).toEqual(['two'])
  })

  it('refuses what would pass the size cap, and keeps what it held', async () => {
    const kept = storage()
    await kept.set('a', 'small', 'fits')
    await expect(kept.set('a', 'big', 'x'.repeat(PLUGIN_STORAGE_LIMITS.bytes))).rejects.toThrow(
      /is full/,
    )
    expect(await storage().keys('a')).toEqual(['small'])
  })

  it('refuses a key past the count cap and a key that is empty or too long', async () => {
    const kept = storage()
    for (let i = 0; i < PLUGIN_STORAGE_LIMITS.keys; i++) await kept.set('a', `k${i}`, 0)
    await expect(kept.set('a', 'one more', 0)).rejects.toThrow(/at most 1000 keys/)
    // A key already held is still set.
    await kept.set('a', 'k0', 1)
    await expect(kept.set('b', '', 0)).rejects.toThrow(/1 to 128 characters/)
    await expect(kept.set('b', 'k'.repeat(129), 0)).rejects.toThrow(/1 to 128 characters/)
  })

  it('loses no write to another one made at the same time', async () => {
    const kept = storage()
    await Promise.all(Array.from({ length: 20 }, (_, i) => kept.set('a', `k${i}`, i)))
    expect(await storage().keys('a')).toHaveLength(20)
  })

  it('goes with its plugin: a write after the folder was removed fails and makes no folder', async () => {
    const kept = storage()
    await kept.set('a', 'x', 1)
    await rm(path.join(root, 'a'), { recursive: true })
    kept.forget('a')
    await expect(kept.set('a', 'y', 2)).rejects.toThrow()
    await expect(readFile(path.join(root, 'a', STORAGE_FILE))).rejects.toThrow()
    expect(await kept.keys('a')).toEqual([])
  })

  it('starts empty, and says so in the log, when the file is not JSON', async () => {
    await writeFile(path.join(root, 'a', STORAGE_FILE), '{not json')
    expect(await storage().keys('a')).toEqual([])
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('not JSON'))
  })
})
