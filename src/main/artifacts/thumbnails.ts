// Card thumbnails: each version rendered once in an offscreen window, in a session of its own with
// the window session's protocol and guards, and kept on disk named by its hash. See
// docs/design/artifacts.md#thumbnails.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, type Session, type WebContents } from 'electron'
import {
  fitThumbnail,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_PAGES,
  THUMBNAIL_WIDTH,
  type ThumbnailPage,
} from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import { createLogger } from '../log'
import { restrictPermissions } from '../permissions'
import { filterArtifactRequests, frameArtifact, mayNavigate } from './guards'
import { artifactHost } from './origins'
import { WINDOW_PROXY } from './policy'
import { serveArtifacts, type ArtifactSource } from './protocol'

const log = createLogger('artifacts')

/** In memory: nothing a page stores while it renders outlives the run. */
export const THUMBNAIL_PARTITION = 'overbench-artifact-thumbnails'
/** How long a page may take to load, and the wait after it, before the capture. */
const LOAD_WAIT_MS = 5_000
const SETTLE_MS = 400
/** Enough for a card two across on a 2x display. */
const OUTPUT_WIDTH = 720
const JPEG_QUALITY = 82
/** The thumbnails kept on disk; older ones render again when asked for. */
export const KEPT_THUMBNAILS = 500

const HASH = /^[0-9a-f]{64}$/
const MAX_SIZE = 8_000
const MIN_SIZE = 64
const MAX_OFFSET = 10_000_000
const MAX_PLACE = 9_999

function isWhole(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

/** A canvas layout from the renderer, every field a checked integer, or null for a single page. */
export function parseLayout(value: unknown): ThumbnailPage[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length === 0 || value.length > THUMBNAIL_PAGES) {
    throw new Error('Not a thumbnail layout')
  }
  return value.map((page: unknown) => {
    const p = page as Partial<Record<keyof ThumbnailPage, unknown>> | null
    if (
      typeof p !== 'object' ||
      p === null ||
      !isWhole(p.group, 0, MAX_PLACE) ||
      !isWhole(p.index, 1, MAX_PLACE) ||
      !isWhole(p.x, 0, MAX_OFFSET) ||
      !isWhole(p.y, 0, MAX_OFFSET) ||
      !isWhole(p.width, MIN_SIZE, MAX_SIZE) ||
      !isWhole(p.height, MIN_SIZE, MAX_SIZE)
    ) {
      throw new Error('Not a thumbnail layout')
    }
    return { group: p.group, index: p.index, x: p.x, y: p.y, width: p.width, height: p.height }
  })
}

const FRAME_ATTRIBUTES =
  'sandbox="allow-scripts allow-same-origin" allow="" referrerpolicy="no-referrer"'

/**
 * The document the offscreen window loads: the version in one frame at a page's size, or each page
 * of a canvas in a frame at its own size, scaled to fit. Every value in it is a checked number or
 * the origin main built, so nothing from the page or the renderer reaches the markup as text.
 */
export function thumbnailDocument(
  origin: string,
  version: number,
  layout: ThumbnailPage[] | null,
): string {
  const frame = (query: string, style: string): string =>
    `<iframe src="${origin}?${query}" ${FRAME_ATTRIBUTES} style="${style}"></iframe>`
  let frames: string
  if (!layout) {
    frames = frame(`v=${version}`, `width:${THUMBNAIL_WIDTH}px;height:${THUMBNAIL_HEIGHT}px`)
  } else {
    const fit = fitThumbnail(layout)
    frames = layout
      .map((p) =>
        frame(
          `v=${version}&page=${p.group}.${p.index}`,
          `left:${fit.x + p.x * fit.scale}px;top:${fit.y + p.y * fit.scale}px;` +
            `width:${p.width}px;height:${p.height}px;transform:scale(${fit.scale})`,
        ),
      )
      .join('')
  }
  // A page is white where it draws nothing, as in a browser; between a canvas's pages the card
  // shows through.
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "style-src 'unsafe-inline'; frame-src overbench-artifact:\">" +
    '<style>html,body{margin:0;overflow:hidden;background:transparent}' +
    'iframe{position:absolute;left:0;top:0;border:0;background:white;transform-origin:0 0}</style>' +
    `</head><body>${frames}</body></html>`
  )
}

/** The files to remove so that only the newest `keep` remain, by modification time. */
export function outdated(files: { name: string; mtimeMs: number }[], keep: number): string[] {
  return files
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep)
    .map((file) => file.name)
}

export interface ThumbnailDeps {
  content(id: string, version: number): Promise<ArtifactContentResult>
  /** `artifacts/thumbnails/` in the data folder. */
  dir: string
  source: ArtifactSource
  /** Lets the protocol serve the artifact in this run; returns its origin URL. */
  serve(id: string): string
}

/** Renders card thumbnails one at a time and keeps them on disk. */
export class Thumbnails {
  private queue: Promise<unknown> = Promise.resolve()
  private session: Session | null = null

  constructor(private readonly deps: ThumbnailDeps) {}

  /** The thumbnails' own session: the protocol, the request filter, no permissions, the proxy. */
  async install(session: Session): Promise<void> {
    serveArtifacts(session, this.deps.source)
    filterArtifactRequests(session)
    restrictPermissions(
      session,
      () => false,
      () => true,
    )
    session.on('will-download', (_, item) => item.cancel())
    await session.setProxy(WINDOW_PROXY)
    this.session = session
  }

  /** `artifact:thumbnail`: the version's image as a `data:` URL, or null when it cannot render. */
  thumbnail(id: string, version: number, layout: ThumbnailPage[] | null): Promise<string | null> {
    const run = this.queue.then(() => this.make(id, version, layout))
    this.queue = run.catch(() => {})
    return run
  }

  private async make(
    id: string,
    version: number,
    layout: ThumbnailPage[] | null,
  ): Promise<string | null> {
    const found = await this.deps.content(id, version)
    if (found.kind !== 'found') return null
    const hash = path.basename(found.path, '.html')
    if (!HASH.test(hash)) return null
    const type = layout ? 'png' : 'jpeg'
    const file = path.join(this.deps.dir, `${hash}.${layout ? 'png' : 'jpg'}`)
    const cached = await readFile(file).catch(() => null)
    if (cached) return dataUrl(type, cached)
    const image = await this.render(this.deps.serve(id), version, layout).catch(
      (error: unknown) => {
        log.warn(`Could not render a thumbnail of ${id} version ${version}: ${String(error)}`)
        return null
      },
    )
    if (!image) return null
    await this.keep(file, image).catch((error: unknown) => {
      log.warn(`Could not keep a thumbnail: ${String(error)}`)
    })
    return dataUrl(type, image)
  }

  private async render(
    origin: string,
    version: number,
    layout: ThumbnailPage[] | null,
  ): Promise<Buffer | null> {
    if (!this.session) return null
    const window = new BrowserWindow({
      show: false,
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      useContentSize: true,
      frame: false,
      transparent: layout !== null,
      backgroundColor: layout ? '#00000000' : '#ffffff',
      webPreferences: {
        offscreen: true,
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        disableDialogs: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    })
    try {
      const contents = window.webContents
      guardThumbnail(contents)
      const started = Date.now()
      const loaded = await Promise.race([
        contents
          .loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(thumbnailDocument(origin, version, layout))}`,
          )
          .then(
            () => true,
            () => false,
          ),
        delay(LOAD_WAIT_MS).then(() => true),
      ])
      if (!loaded || window.isDestroyed()) return null
      await delay(Math.min(SETTLE_MS, Math.max(0, LOAD_WAIT_MS - (Date.now() - started))))
      if (window.isDestroyed()) return null
      const captured = await contents.capturePage()
      if (captured.isEmpty()) return null
      const scaled = captured.resize({ width: OUTPUT_WIDTH, quality: 'good' })
      return layout ? scaled.toPNG() : scaled.toJPEG(JPEG_QUALITY)
    } finally {
      if (!window.isDestroyed()) window.destroy()
    }
  }

  private async keep(file: string, image: Buffer): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, image)
    await rename(temporary, file)
    const names = (await readdir(this.deps.dir)).filter((name) => /\.(png|jpg)$/.test(name))
    if (names.length <= KEPT_THUMBNAILS) return
    const files = await Promise.all(
      names.map(async (name) => {
        const stats = await stat(path.join(this.deps.dir, name)).catch(() => null)
        return { name, mtimeMs: stats?.mtimeMs ?? 0 }
      }),
    )
    await Promise.all(
      outdated(files, KEPT_THUMBNAILS).map((name) =>
        rm(path.join(this.deps.dir, name), { force: true }),
      ),
    )
  }
}

/** The offscreen window opens nothing, moves nowhere and plays nothing. */
function guardThumbnail(contents: WebContents): void {
  contents.setAudioMuted(true)
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  // A frame of the document loads its artifact first; from then on it stays on that origin.
  contents.on('will-frame-navigate', (details) => {
    const frame = details.frame
    if (details.isMainFrame || details.isSameDocument || !frame) return
    const host = frameArtifact(frame)
    const branch = frame.parent !== null && frame.parent.parent === null
    const allowed =
      host === null ? artifactHost(details.url) !== null : mayNavigate(host, details.url, branch)
    if (!allowed) details.preventDefault()
  })
}

function dataUrl(type: 'png' | 'jpeg', image: Buffer): string {
  return `data:image/${type};base64,${image.toString('base64')}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
