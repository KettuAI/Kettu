import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThumbnailPage } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'

const opened = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      opened()
      throw new Error('No window in tests')
    }
  },
  protocol: {},
}))

const { loadWait, outdated, parseLayout, thumbnailDocument, Thumbnails } =
  await import('./thumbnails')

const ORIGIN = 'overbench-artifact://0123456789abcdef0123456789/'
const PAGE: ThumbnailPage = { group: 1, index: 2, x: 0, y: 0, width: 390, height: 844 }

describe('parseLayout', () => {
  it('takes null for a single page, and checked pages for a canvas', () => {
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout([PAGE, { ...PAGE, x: 438, extra: 'dropped' }])).toEqual([
      PAGE,
      { ...PAGE, x: 438 },
    ])
  })

  it.each([
    ['no pages', []],
    ['too many pages', Array.from({ length: 501 }, () => PAGE)],
    ['not a list', { 0: PAGE }],
    ['a page that is not an object', [PAGE, 'page']],
    ['a fraction', [{ ...PAGE, x: 1.5 }]],
    ['a string', [{ ...PAGE, y: '0' }]],
    ['a negative offset', [{ ...PAGE, x: -1 }]],
    ['a page too small', [{ ...PAGE, width: 63 }]],
    ['a page too large', [{ ...PAGE, height: 8001 }]],
    ['index 0', [{ ...PAGE, index: 0 }]],
    ['a missing field', [{ group: 1, index: 1, x: 0, y: 0, width: 100 }]],
  ])('refuses %s', (_, value) => {
    expect(() => parseLayout(value)).toThrow('Not a thumbnail layout')
  })
})

describe('thumbnailDocument', () => {
  it('frames a single page at the thumbnail size, sandboxed, on its version', () => {
    const html = thumbnailDocument(ORIGIN, 3, null)
    const frames = html.match(/<iframe [^>]*>/g)!
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain(`src="${ORIGIN}?v=3"`)
    expect(frames[0]).toContain('sandbox="allow-scripts allow-same-origin"')
    expect(frames[0]).toContain('width:1280px;height:800px')
    expect(html).toContain('frame-src overbench-artifact:')
  })

  it('frames each page of a canvas at its own size, scaled to fit', () => {
    const html = thumbnailDocument(ORIGIN, 2, [
      { group: 0, index: 1, x: 0, y: 0, width: 1280, height: 800 },
      { group: 0, index: 2, x: 1328, y: 0, width: 1280, height: 800 },
    ])
    const frames = html.match(/<iframe [^>]*>/g)!
    expect(frames).toHaveLength(2)
    expect(frames[0]).toContain(`src="${ORIGIN}?v=2&page=0.1"`)
    expect(frames[1]).toContain(`src="${ORIGIN}?v=2&page=0.2"`)
    expect(frames[1]).toContain('width:1280px;height:800px;transform:scale(')
  })
})

describe('outdated', () => {
  it('names all but the newest ones', () => {
    const files = [
      { name: 'b.jpg', mtimeMs: 2 },
      { name: 'a.png', mtimeMs: 3 },
      { name: 'c.jpg', mtimeMs: 1 },
    ]
    expect(outdated(files, 2)).toEqual(['c.jpg'])
    expect(outdated(files, 3)).toEqual([])
  })
})

describe('loadWait', () => {
  it('grows with the pages, each a frame that loads the whole page, up to a limit', () => {
    expect(loadWait(1)).toBe(5_000)
    expect(loadWait(24)).toBe(28_000)
    expect(loadWait(40)).toBe(30_000)
  })
})

describe('Thumbnails', () => {
  const HASH = 'ab'.repeat(32)
  const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW'
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-thumbnails-'))
    opened.mockReset()
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const thumbnails = (found: ArtifactContentResult) =>
    new Thumbnails({
      content: () => Promise.resolve(found),
      dir,
      source: {
        contentDir: dir,
        artifactOf: () => undefined,
        content: () => Promise.resolve(found),
      },
      serve: () => ORIGIN,
    })

  it("serves a version's kept image without rendering it again", async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${HASH}.jpg`), 'page')
    await writeFile(path.join(dir, `${HASH}.png`), 'canvas')
    const found: ArtifactContentResult = {
      kind: 'found',
      path: `/c/ab/${HASH}.html`,
      version: 1,
      title: 'Page',
    }
    expect(await thumbnails(found).thumbnail(ID, 1, null)).toBe(
      `data:image/jpeg;base64,${Buffer.from('page').toString('base64')}`,
    )
    expect(await thumbnails(found).thumbnail(ID, 1, [PAGE, PAGE])).toBe(
      `data:image/png;base64,${Buffer.from('canvas').toString('base64')}`,
    )
    expect(opened).not.toHaveBeenCalled()
  })

  it('gives null for a version the host does not know or cannot name', async () => {
    expect(await thumbnails({ kind: 'not_found' }).thumbnail(ID, 1, null)).toBeNull()
    expect(await thumbnails({ kind: 'failed' }).thumbnail(ID, 1, null)).toBeNull()
    const odd: ArtifactContentResult = {
      kind: 'found',
      path: '/c/ab/../x.html',
      version: 1,
      title: 'Page',
    }
    expect(await thumbnails(odd).thumbnail(ID, 1, null)).toBeNull()
    expect(opened).not.toHaveBeenCalled()
  })

  it('gives null when the page cannot render, and keeps nothing', async () => {
    const found: ArtifactContentResult = {
      kind: 'found',
      path: `/c/ab/${HASH}.html`,
      version: 1,
      title: 'Page',
    }
    const made = thumbnails(found)
    // Not installed, so nothing renders.
    expect(await made.thumbnail(ID, 1, null)).toBeNull()
    await made.install({
      protocol: { handle: () => {} },
      webRequest: { onBeforeRequest: () => {} },
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDevicePermissionHandler: () => {},
      on: () => {},
      setProxy: () => Promise.resolve(),
    } as unknown as Electron.Session)
    expect(await made.thumbnail(ID, 1, null)).toBeNull()
    expect(opened).toHaveBeenCalledOnce()
    expect(await readdir(dir)).toEqual([])
  })
})
