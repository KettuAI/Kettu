import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SiteIconEvent } from '@shared/ipc'
import {
  dataIcon,
  MAX_ICON_BYTES,
  MAX_SITES,
  parseSiteIcons,
  pickFavicon,
  SiteIcons,
  type IconFetch,
} from './site-icons'

const folders: string[] = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function tempFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'kettu-site-icons-'))
  folders.push(folder)
  return folder
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const PNG_ICON = `data:image/png;base64,${PNG.toString('base64')}`

const image = (body: Buffer | string, type: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } })

async function icons(
  answer: (url: string) => Response | Promise<Response> = () => image(PNG, 'image/png'),
) {
  const folder = await tempFolder()
  const events: SiteIconEvent[] = []
  const fetch = vi.fn<IconFetch>(async (url) => answer(url))
  const store = await SiteIcons.load(folder, { fetch, changed: (event) => events.push(event) })
  return { store, events, fetch, folder }
}

describe('pickFavicon', () => {
  it('takes the first http, https or data icon', () => {
    expect(pickFavicon(['file:///x.ico', 'https://a.com/1.png', 'https://a.com/2.png'])).toBe(
      'https://a.com/1.png',
    )
    expect(pickFavicon(['data:image/png;base64,AA=='])).toBe('data:image/png;base64,AA==')
  })

  it('has none among other schemes, text that is no URL, or values that are no text', () => {
    expect(pickFavicon(['javascript:alert(1)', 'not a url', 42, 'kettu-media://x'])).toBeNull()
    expect(pickFavicon([])).toBeNull()
  })
})

describe('dataIcon', () => {
  it('keeps an image as base64', () => {
    expect(dataIcon(PNG_ICON)).toBe(PNG_ICON)
    expect(dataIcon('data:image/svg+xml,%3Csvg%2F%3E')).toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    )
  })

  it.each([
    'data:text/html;base64,PGI+',
    'data:,hello',
    'data:image/png;base64,***',
    'data:image/png;base64,',
    'data:image/svg+xml,%E0%A4%A',
    'https://example.com/favicon.ico',
  ])('refuses %j', (url) => {
    expect(dataIcon(url)).toBeNull()
  })

  it('refuses an icon larger than the limit', () => {
    const big = Buffer.alloc(MAX_ICON_BYTES + 1).toString('base64')
    expect(dataIcon(`data:image/png;base64,${big}`)).toBeNull()
  })
})

describe('parseSiteIcons', () => {
  it('keeps each fit site, oldest first, and drops an icon that is not an image data URL', () => {
    const sites = parseSiteIcons({
      version: 1,
      sites: [
        { origin: 'https://kettu.sh', icon: PNG_ICON, source: 'https://kettu.sh/favicon.png' },
        { origin: 'https://example.com', icon: 'https://example.com/favicon.ico', source: 'x' },
        { origin: 'https://example.com/path', icon: null, source: null },
        { origin: 'file:///etc', icon: null, source: null },
        'nonsense',
      ],
    })
    expect([...sites]).toEqual([
      ['https://kettu.sh', { icon: PNG_ICON, source: 'https://kettu.sh/favicon.png' }],
      ['https://example.com', { icon: null, source: null }],
    ])
  })

  it.each([null, [], 'x', { sites: {} }])('reads nothing from %j', (raw) => {
    expect(parseSiteIcons(raw).size).toBe(0)
  })
})

describe('SiteIcons', () => {
  it('records a visit without an icon once, and tells the window', async () => {
    const { store, events } = await icons()
    store.visited('https://docs.kettu.sh/remote')
    store.visited('https://docs.kettu.sh/other')
    expect(store.all()).toEqual({ 'https://docs.kettu.sh': null })
    expect(events).toEqual([{ kind: 'set', origin: 'https://docs.kettu.sh', icon: null }])
  })

  it("loads a page's icon through the partition with its cookies and cache", async () => {
    const { store, events, fetch } = await icons()
    await store.favicons('https://docs.kettu.sh/remote', ['https://docs.kettu.sh/favicon.png'])
    expect(fetch).toHaveBeenCalledWith(
      'https://docs.kettu.sh/favicon.png',
      expect.objectContaining({ credentials: 'include', cache: 'force-cache' }),
    )
    expect(store.all()).toEqual({ 'https://docs.kettu.sh': PNG_ICON })
    expect(events.at(-1)).toEqual({ kind: 'set', origin: 'https://docs.kettu.sh', icon: PNG_ICON })
  })

  it('does not load the same icon again', async () => {
    const { store, fetch } = await icons()
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    await store.favicons('https://kettu.sh/a', ['https://kettu.sh/favicon.png'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('takes a data icon without loading anything', async () => {
    const { store, fetch } = await icons()
    await store.favicons('https://kettu.sh/', [PNG_ICON])
    expect(fetch).not.toHaveBeenCalled()
    expect(store.all()).toEqual({ 'https://kettu.sh': PNG_ICON })
  })

  it.each([
    ['an answer that is no image', () => image('<html>', 'text/html')],
    ['a failed answer', () => image(PNG, 'image/png', 404)],
    ['an icon too large', () => image(Buffer.alloc(MAX_ICON_BYTES + 1), 'image/png')],
    [
      'a load that fails',
      () => {
        throw new Error('net::ERR_FAILED')
      },
    ],
  ])('keeps the visit but no icon for %s', async (_, answer) => {
    const { store } = await icons(answer)
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    expect(store.all()).toEqual({ 'https://kettu.sh': null })
  })

  it('keeps only the latest of two loads for one site', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const { store } = await icons(async (url) => {
      if (url.endsWith('old.png')) await held
      return image(url.endsWith('old.png') ? Buffer.from('old') : PNG, 'image/png')
    })
    const old = store.favicons('https://kettu.sh/', ['https://kettu.sh/old.png'])
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/new.png'])
    release()
    await old
    expect(store.all()).toEqual({ 'https://kettu.sh': PNG_ICON })
  })

  it('forgets the site opened longest ago beyond the limit', async () => {
    const { store, events } = await icons()
    for (let i = 0; i <= MAX_SITES; i++) store.visited(`https://site${i}.example/`)
    store.visited('https://site1.example/')
    store.visited('https://new.example/')
    const origins = Object.keys(store.all())
    expect(origins).toHaveLength(MAX_SITES)
    expect(origins).not.toContain('https://site0.example')
    expect(origins).not.toContain('https://site2.example')
    expect(origins.at(-2)).toBe('https://site1.example')
    expect(events).toContainEqual({ kind: 'removed', origin: 'https://site0.example' })
  })

  it('clears every site, and a load that ends after it keeps nothing', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const { store, events } = await icons(async () => {
      await held
      return image(PNG, 'image/png')
    })
    const load = store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    store.clear()
    release()
    await load
    expect(store.all()).toEqual({})
    expect(events.at(-1)).toEqual({ kind: 'cleared' })
  })

  it('writes the sites to state/site-icons.json and reads them back', async () => {
    const { store, folder } = await icons()
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    store.visited('https://example.com/')
    await store.flush()
    const file = path.join(folder, 'state', 'site-icons.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sites: [
        { origin: 'https://kettu.sh', icon: PNG_ICON, source: 'https://kettu.sh/favicon.png' },
        { origin: 'https://example.com', icon: null, source: null },
      ],
    })
    const reopened = await SiteIcons.load(folder, { fetch: vi.fn(), changed: () => {} })
    expect(reopened.all()).toEqual({ 'https://kettu.sh': PNG_ICON, 'https://example.com': null })
  })

  it('starts empty from a file that is not JSON', async () => {
    const folder = await tempFolder()
    await mkdir(path.join(folder, 'state'), { recursive: true })
    await writeFile(path.join(folder, 'state', 'site-icons.json'), '{ not json')
    const store = await SiteIcons.load(folder, { fetch: vi.fn(), changed: () => {} })
    expect(store.all()).toEqual({})
  })
})
