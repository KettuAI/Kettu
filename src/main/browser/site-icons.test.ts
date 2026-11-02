import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SiteIconEvent } from '@shared/ipc'
import {
  dataIcon,
  LOAD_GAP_MS,
  MAX_ICON_BYTES,
  MAX_SITES,
  parseSiteIcons,
  pickFavicon,
  SiteIcons,
  type IconFetch,
} from './site-icons'

const folders: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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
  answer: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    image(PNG, 'image/png'),
) {
  const folder = await tempFolder()
  const events: SiteIconEvent[] = []
  const fetch = vi.fn<IconFetch>(async (url, init) => answer(url, init))
  const store = SiteIcons.open(folder, { fetch, changed: (event) => events.push(event) })
  await store.ready
  return { store, events, fetch, folder }
}

/** An answer that never comes, failing as fetch does once the load is stopped. */
function untilStopped(init: RequestInit): Promise<never> {
  return new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))
  })
}

const loaded = (fetch: { mock: { calls: [string, RequestInit][] } }) =>
  fetch.mock.calls.map(([url]) => url)

// Only the timers the gap uses, so reading bodies and files runs as it does outside tests.
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

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

  it('keeps an icon of the largest size, however it is encoded', () => {
    const most = Buffer.alloc(MAX_ICON_BYTES, 0x41)
    expect(dataIcon(`data:image/svg+xml,${'%41'.repeat(MAX_ICON_BYTES)}`)).toBe(
      `data:image/svg+xml;base64,${most.toString('base64')}`,
    )
    expect(dataIcon(`data:image/png;base64,${most.toString('base64')}`)).not.toBeNull()
  })

  it('refuses an address too long for a fit icon without decoding it', () => {
    const from = vi.spyOn(Buffer, 'from')
    expect(dataIcon(`data:image/png;base64,${'A'.repeat(MAX_ICON_BYTES * 4)}`)).toBeNull()
    expect(from).not.toHaveBeenCalled()
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

  it('drops an icon kept when larger ones were allowed', () => {
    const big = `data:image/png;base64,${Buffer.alloc(MAX_ICON_BYTES * 2).toString('base64')}`
    const sites = parseSiteIcons({
      sites: [{ origin: 'https://kettu.sh', icon: big, source: 'https://kettu.sh/big.png' }],
    })
    expect([...sites]).toEqual([['https://kettu.sh', { icon: null, source: null }]])
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
    expect(await store.all()).toEqual({ 'https://docs.kettu.sh': null })
    expect(events).toEqual([{ kind: 'set', origin: 'https://docs.kettu.sh', icon: null }])
  })

  it("loads a page's icon through the partition's cache, without cookies", async () => {
    const { store, events, fetch } = await icons()
    await store.favicons('https://docs.kettu.sh/remote', ['https://docs.kettu.sh/favicon.png'])
    expect(fetch).toHaveBeenCalledWith(
      'https://docs.kettu.sh/favicon.png',
      expect.objectContaining({ credentials: 'omit', cache: 'force-cache' }),
    )
    expect(await store.all()).toEqual({ 'https://docs.kettu.sh': PNG_ICON })
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
    expect(await store.all()).toEqual({ 'https://kettu.sh': PNG_ICON })
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
    expect(await store.all()).toEqual({ 'https://kettu.sh': null })
  })

  it('starts one load per site in the gap, then only the latest icon named', async () => {
    fakeTimers()
    const { store, fetch } = await icons()
    for (const name of ['a', 'b', 'c', 'd']) {
      await store.favicons('https://kettu.sh/', [`https://kettu.sh/${name}.png`])
    }
    expect(loaded(fetch)).toEqual(['https://kettu.sh/a.png'])
    await vi.advanceTimersByTimeAsync(LOAD_GAP_MS - 1)
    expect(loaded(fetch)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(loaded(fetch)).toEqual(['https://kettu.sh/a.png', 'https://kettu.sh/d.png'])
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/e.png'])
    expect(loaded(fetch)).toHaveLength(2)
  })

  it('holds back no other site', async () => {
    fakeTimers()
    const { store, fetch } = await icons()
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    await store.favicons('https://example.com/', ['https://example.com/favicon.png'])
    expect(loaded(fetch)).toEqual([
      'https://kettu.sh/favicon.png',
      'https://example.com/favicon.png',
    ])
  })

  it('drops a waiting icon when the page names the one it has again', async () => {
    fakeTimers()
    const { store, fetch } = await icons()
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/other.png'])
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    await vi.advanceTimersByTimeAsync(LOAD_GAP_MS)
    expect(loaded(fetch)).toEqual(['https://kettu.sh/favicon.png'])
  })

  it('stops the load in flight when the next one starts, and keeps only the next', async () => {
    fakeTimers()
    const { store, fetch } = await icons(async (url, init) =>
      url.endsWith('old.png') ? untilStopped(init) : image(PNG, 'image/png'),
    )
    const old = store.favicons('https://kettu.sh/', ['https://kettu.sh/old.png'])
    await store.favicons('https://kettu.sh/', ['https://kettu.sh/new.png'])
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(LOAD_GAP_MS)
    await old
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true)
    await vi.waitFor(async () => {
      expect(await store.all()).toEqual({ 'https://kettu.sh': PNG_ICON })
    })
  })

  it('stops the load in flight for a data icon named after it', async () => {
    const { store, fetch } = await icons(async (_, init) => untilStopped(init))
    const load = store.favicons('https://kettu.sh/', ['https://kettu.sh/favicon.png'])
    await store.favicons('https://kettu.sh/', [PNG_ICON])
    await load
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true)
    expect(await store.all()).toEqual({ 'https://kettu.sh': PNG_ICON })
  })

  it('forgets the site opened longest ago beyond the limit', async () => {
    const { store, events } = await icons()
    for (let i = 0; i <= MAX_SITES; i++) store.visited(`https://site${i}.example/`)
    store.visited('https://site1.example/')
    store.visited('https://new.example/')
    const origins = Object.keys(await store.all())
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
    expect(await store.all()).toEqual({})
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
    const reopened = SiteIcons.open(folder, { fetch: vi.fn(), changed: () => {} })
    expect(await reopened.all()).toEqual({
      'https://kettu.sh': PNG_ICON,
      'https://example.com': null,
    })
  })

  it('answers with the icons only once the file is read, with changes made before on top', async () => {
    const folder = await tempFolder()
    await mkdir(path.join(folder, 'state'), { recursive: true })
    await writeFile(
      path.join(folder, 'state', 'site-icons.json'),
      JSON.stringify({
        version: 1,
        sites: [{ origin: 'https://kettu.sh', icon: PNG_ICON, source: 'https://kettu.sh/a.png' }],
      }),
    )
    const store = SiteIcons.open(folder, { fetch: vi.fn(), changed: () => {} })
    const early = store.all()
    store.visited('https://example.com/')
    expect(await early).toEqual({ 'https://kettu.sh': PNG_ICON, 'https://example.com': null })
    store.clear()
    expect(await store.all()).toEqual({})
  })

  it('starts empty from a file that is not JSON', async () => {
    const folder = await tempFolder()
    await mkdir(path.join(folder, 'state'), { recursive: true })
    await writeFile(path.join(folder, 'state', 'site-icons.json'), '{ not json')
    const store = SiteIcons.open(folder, { fetch: vi.fn(), changed: () => {} })
    expect(await store.all()).toEqual({})
  })
})
