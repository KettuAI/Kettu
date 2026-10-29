import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pagesToForget,
  pagesToUnpublish,
  SharingStore,
  type PublishedPage,
  type TokenCipher,
} from './store'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const WORKER = 'ob-aaaaaaaaaaaaaaaa'
const ARTIFACT = 'art_01J00000000000000000000000'
const OTHER_ARTIFACT = 'art_01J00000000000000000000001'

const cipher: TokenCipher = {
  encrypt: async (text) => Buffer.from(`sealed:${text}`, 'utf8').toString('base64'),
  decrypt: async (text) => {
    const value = Buffer.from(text, 'base64').toString('utf8')
    if (!value.startsWith('sealed:')) throw new Error('Not sealed')
    return value.slice('sealed:'.length)
  },
}

const page = (over: Partial<PublishedPage> = {}): PublishedPage => ({
  id: ARTIFACT,
  worker: WORKER,
  url: `https://${WORKER}.team.workers.dev/`,
  version: 2,
  publishedAt: 1_700_000_000_000,
  accountId: ACCOUNT,
  ...over,
})

let dirs: string[] = []

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kettu-sharing-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

describe('SharingStore', () => {
  it('stores the token encrypted and brings it back across a load', async () => {
    const dir = await temp()
    const store = await SharingStore.load(dir, cipher)
    await store.connect(ACCOUNT, 'team', 'secret-token', false)
    await store.flush()

    const file = await readFile(join(dir, 'published-artifacts.json'), 'utf8')
    expect(file).not.toContain('secret-token')
    expect(JSON.parse(file)).toMatchObject({
      version: 1,
      account: { accountId: ACCOUNT, subdomain: 'team', plainText: false },
    })

    const loaded = await SharingStore.load(dir, cipher)
    expect(loaded.account()).toMatchObject({ accountId: ACCOUNT, subdomain: 'team' })
    await expect(loaded.token()).resolves.toBe('secret-token')
  })

  it('round trips published pages, replacing one artifact instead of adding it twice', async () => {
    const dir = await temp()
    const store = await SharingStore.load(dir, cipher)
    await store.connect(ACCOUNT, 'team', 'secret-token', true)
    store.put(page())
    store.put(page({ version: 3, publishedAt: 1_700_000_000_999 }))
    store.put(page({ id: OTHER_ARTIFACT, worker: 'ob-bbbbbbbbbbbbbbbb' }))
    await store.flush()

    const loaded = await SharingStore.load(dir, cipher)
    expect(loaded.published()).toHaveLength(2)
    expect(loaded.page(ARTIFACT)).toMatchObject({ version: 3, publishedAt: 1_700_000_000_999 })
    expect(loaded.account()?.plainText).toBe(true)
  })

  it('forgets the account but leaves the pages it published', async () => {
    const dir = await temp()
    const store = await SharingStore.load(dir, cipher)
    await store.connect(ACCOUNT, 'team', 'secret-token', false)
    store.put(page())
    store.removeAccount()
    await store.flush()

    const loaded = await SharingStore.load(dir, cipher)
    expect(loaded.account()).toBeNull()
    expect(loaded.published()).toHaveLength(1)
    await expect(loaded.token()).resolves.toBeNull()
  })

  it('forgets one page and keeps the rest', async () => {
    const dir = await temp()
    const store = await SharingStore.load(dir, cipher)
    store.put(page())
    store.put(page({ id: OTHER_ARTIFACT, worker: 'ob-bbbbbbbbbbbbbbbb' }))
    store.forget(ARTIFACT)
    await store.flush()

    const loaded = await SharingStore.load(dir, cipher)
    expect(loaded.published().map((entry) => entry.id)).toEqual([OTHER_ARTIFACT])
  })

  it('moves an invalid file aside and starts empty', async () => {
    const dir = await temp()
    await writeFile(
      join(dir, 'published-artifacts.json'),
      JSON.stringify({ version: 1, account: { accountId: 'nope' }, published: [] }),
      'utf8',
    )
    const store = await SharingStore.load(dir, cipher)
    expect(store.account()).toBeNull()
    expect(store.published()).toEqual([])
    const kept = await readFile(join(dir, 'published-artifacts.json'), 'utf8').catch(() => null)
    expect(kept).toBeNull()
  })
})

describe('launch reconciliation', () => {
  it('takes down the pages whose artifact the host no longer has', () => {
    const pages = [
      page(),
      page({ id: OTHER_ARTIFACT }),
      page({ id: 'art_01J00000000000000000000002', accountId: OTHER }),
    ]
    expect(pagesToUnpublish(pages, new Set([ARTIFACT]), ACCOUNT)).toEqual([
      expect.objectContaining({ id: OTHER_ARTIFACT }),
    ])
  })

  it('forgets the pages Cloudflare no longer has, from this account only', () => {
    const pages = [
      page(),
      page({ id: OTHER_ARTIFACT, worker: 'ob-bbbbbbbbbbbbbbbb' }),
      page({ id: 'art_01J00000000000000000000002', accountId: OTHER }),
    ]
    expect(pagesToForget(pages, new Set([WORKER]), ACCOUNT)).toEqual([
      expect.objectContaining({ id: OTHER_ARTIFACT }),
    ])
  })
})
