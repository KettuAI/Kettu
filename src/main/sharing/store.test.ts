import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pagesToForget,
  pagesToUnpublish,
  pageUrl,
  parseSharingFile,
  SharingStore,
  type PublishedPage,
} from './store'

const ARTIFACT = `art_${'A'.repeat(26)}`
const OTHER_ARTIFACT = `art_${'B'.repeat(26)}`
const CLOUDFLARE = '0123456789abcdef0123456789abcdef'
const KETTU = '6f9619ff-8b86-d011-b42d-00c04fc964ff'
const PAGE = 'abcdefghijklmnopqrst'

const cipher = {
  encrypt: async (text: string) => `sealed:${text}`,
  decrypt: async (text: string) => text.replace(/^sealed:/, ''),
}

function kettuPage(overrides: Partial<PublishedPage> = {}): PublishedPage {
  return {
    id: ARTIFACT,
    target: 'kettu',
    ref: PAGE,
    url: `https://${PAGE}.pages.example/`,
    version: 3,
    publishedAt: 1_000,
    accountId: KETTU,
    accountEmail: 'ada@example.com',
    access: 'private',
    code: null,
    ...overrides,
  }
}

const version1 = {
  version: 1,
  account: { accountId: CLOUDFLARE, subdomain: 'ada', token: 'sealed:t', plainText: false },
  published: [
    {
      id: ARTIFACT,
      worker: 'ob-abcdefghijklmnop',
      url: 'https://ob-abcdefghijklmnop.ada.workers.dev/',
      version: 2,
      publishedAt: 500,
      accountId: CLOUDFLARE,
    },
  ],
}

describe('parseSharingFile', () => {
  it('reads the pages of version 1 as Cloudflare pages', () => {
    expect(parseSharingFile(version1)).toEqual({
      version: 3,
      account: version1.account,
      auto: null,
      published: [
        {
          id: ARTIFACT,
          target: 'cloudflare',
          ref: 'ob-abcdefghijklmnop',
          url: 'https://ob-abcdefghijklmnop.ada.workers.dev/',
          version: 2,
          publishedAt: 500,
          accountId: CLOUDFLARE,
          accountEmail: null,
          access: 'public',
          code: null,
        },
      ],
    })
  })

  it('reads a Kettu page from before levels as public', () => {
    const before: Partial<PublishedPage> = kettuPage()
    delete before.access
    delete before.code
    expect(parseSharingFile({ version: 2, account: null, published: [before] })?.published).toEqual(
      [kettuPage({ access: 'public', code: null })],
    )
  })

  it('keeps a Kettu page with a short id, as the service gives new pages', () => {
    const page = kettuPage({ ref: 'k7m2x4qdnb', url: 'https://k7m2x4qdnb.pages.example/' })
    expect(parseSharingFile({ version: 2, account: null, published: [page] })?.published).toEqual([
      page,
    ])
  })

  it('keeps a Kettu page’s level and access code', () => {
    const page = kettuPage({ access: 'code', code: 'k7m2' })
    expect(parseSharingFile({ version: 2, account: null, published: [page] })?.published).toEqual([
      page,
    ])
  })

  it('refuses a level or code that does not fit', () => {
    const wrong: Partial<PublishedPage>[] = [
      { access: 'friends' as PublishedPage['access'] },
      { access: 'code', code: null },
      { access: 'code', code: 'K7M2' },
      { access: 'code', code: 'k7m0' },
      { access: 'code', code: 'k7m22' },
      { access: 'private', code: 'k7m2' },
      { access: 'public', code: 'k7m2' },
    ]
    for (const overrides of wrong) {
      expect(
        parseSharingFile({ version: 2, account: null, published: [kettuPage(overrides)] }),
        JSON.stringify(overrides),
      ).toBeNull()
    }
  })

  it('keeps a Kettu page with its account', () => {
    const page = kettuPage()
    expect(parseSharingFile({ version: 2, account: null, published: [page] })).toEqual({
      version: 3,
      account: null,
      published: [page],
      auto: null,
    })
  })

  it('keeps the state of automatic publishing of a version 3 file', () => {
    const auto = {
      enabled: true,
      confirmed: false,
      since: 1_000,
      accountId: KETTU,
      declined: [ARTIFACT],
    }
    expect(parseSharingFile({ version: 3, account: null, published: [], auto })?.auto).toEqual(auto)
  })

  it('refuses automatic publishing state that does not fit', () => {
    const good = { enabled: true, confirmed: true, since: null, accountId: null, declined: [] }
    const wrong = [
      { ...good, enabled: 'yes' },
      { ...good, since: -1 },
      { ...good, accountId: 'not an account!' },
      { ...good, declined: ['nope'] },
      { ...good, declined: 'none' },
    ]
    for (const auto of wrong) {
      expect(parseSharingFile({ version: 3, account: null, published: [], auto })).toBeNull()
    }
  })

  it('refuses a page whose ref or account does not fit its target', () => {
    const wrong: Partial<PublishedPage>[] = [
      { ref: 'ob-abcdefghijklmnop' },
      { ref: 'ABCDEFGHIJKLMNOPQRST' },
      { ref: 'abcdefghi' },
      { ref: 'abcdefghijklmno' },
      { ref: 'k7m2x9qdn1' },
      { accountId: '' },
      { accountId: 'a/b' },
      { target: 'cloudflare' },
      { target: 'elsewhere' as PublishedPage['target'] },
      { url: 'http://example.com/' },
      { url: 'javascript:alert(1)' },
      { accountEmail: 7 as unknown as string },
    ]
    for (const overrides of wrong) {
      expect(
        parseSharingFile({ version: 2, account: null, published: [kettuPage(overrides)] }),
      ).toBeNull()
    }
  })

  it('refuses a Cloudflare page with an email, a plain http address or a level', () => {
    const cloudflare: PublishedPage = {
      ...kettuPage(),
      target: 'cloudflare',
      ref: 'ob-abcdefghijklmnop',
      url: 'https://ob-abcdefghijklmnop.ada.workers.dev/',
      accountId: CLOUDFLARE,
      accountEmail: null,
      access: 'public',
    }
    expect(parseSharingFile({ version: 2, account: null, published: [cloudflare] })).not.toBeNull()
    for (const overrides of [
      { accountEmail: 'ada@example.com' },
      { url: 'http://ob-abcdefghijklmnop.localhost/' },
      { access: 'private' as const },
    ]) {
      expect(
        parseSharingFile({
          version: 2,
          account: null,
          published: [{ ...cloudflare, ...overrides }],
        }),
      ).toBeNull()
    }
  })

  it('refuses two pages of one artifact and unknown versions', () => {
    const page = kettuPage()
    expect(parseSharingFile({ version: 2, account: null, published: [page, page] })).toBeNull()
    expect(parseSharingFile({ version: 3, account: null, published: [] })).toBeNull()
  })
})

describe('pageUrl', () => {
  it('takes https, and http only on a loopback name', () => {
    expect(pageUrl(`https://${PAGE}.pages.example/`)).toBe(`https://${PAGE}.pages.example/`)
    expect(pageUrl(`http://${PAGE}.share.localhost:8808/`)).toBe(
      `http://${PAGE}.share.localhost:8808/`,
    )
    expect(pageUrl(`http://${PAGE}.pages.example/`)).toBeNull()
    expect(pageUrl('https://user:pass@pages.example/')).toBeNull()
    expect(pageUrl('file:///etc/passwd')).toBeNull()
    expect(pageUrl(42)).toBeNull()
  })
})

describe('pagesToUnpublish and pagesToForget', () => {
  const pages = [
    kettuPage(),
    kettuPage({ id: OTHER_ARTIFACT, ref: 'bcdefghijklmnopqrstu', accountId: 'another-account' }),
    {
      ...kettuPage({ id: `art_${'C'.repeat(26)}` }),
      target: 'cloudflare' as const,
      ref: 'ob-abcdefghijklmnop',
      accountId: CLOUDFLARE,
      accountEmail: null,
      access: 'public' as const,
    },
  ]

  it('takes only the pages of the target and account', () => {
    expect(pagesToUnpublish(pages, new Set(), 'kettu', KETTU).map((page) => page.id)).toEqual([
      ARTIFACT,
    ])
    expect(pagesToUnpublish(pages, new Set([ARTIFACT]), 'kettu', KETTU)).toEqual([])
    expect(
      pagesToForget(pages, new Set(), 'cloudflare', CLOUDFLARE).map((page) => page.id),
    ).toEqual([`art_${'C'.repeat(26)}`])
    expect(pagesToForget(pages, new Set([PAGE]), 'kettu', KETTU)).toEqual([])
  })
})

describe('SharingStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kettu-sharing-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a file of version 1 back as version 3', async () => {
    const path = join(dir, 'published-artifacts.json')
    await writeFile(path, JSON.stringify(version1))
    const store = await SharingStore.load(dir, cipher)
    expect(store.page(ARTIFACT)?.target).toBe('cloudflare')
    store.put(kettuPage({ id: OTHER_ARTIFACT }))
    await store.flush()
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      version: number
      published: PublishedPage[]
    }
    expect(written.version).toBe(3)
    expect(written.published.map((page) => [page.id, page.target, page.accountId])).toEqual([
      [ARTIFACT, 'cloudflare', CLOUDFLARE],
      [OTHER_ARTIFACT, 'kettu', KETTU],
    ])
    expect(parseSharingFile(written)).not.toBeNull()
  })
})
