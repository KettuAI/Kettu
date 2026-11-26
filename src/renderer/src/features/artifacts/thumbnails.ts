// Card thumbnails, asked for as cards scroll into view, a few at a time in that order. Main renders
// and keeps them on disk; this keeps the ones shown in this run.

import { useEffect, useSyncExternalStore } from 'react'
import { fitThumbnail, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@shared/artifacts'
import type { ArtifactSummary, ThumbnailPart } from '@shared/artifacts'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import { artifactRefOf, host } from '@renderer/lib/host'
import { parseCanvas, thumbnailLayout } from './canvas'
import { docThumbnailLayout } from './canvas-model'

/** A canvas's pages in its thumbnail, as shares of its width and height, for their outlines. */
export interface PageBox {
  left: number
  top: number
  width: number
  height: number
  /** A canvas document's page: its HTML file. */
  file?: string
}

export type Thumbnail =
  | { state: 'loading' }
  | { state: 'ready'; src: string; pages: PageBox[] | null }
  | { state: 'failed' }

/** What a thumbnail is made from: the version, and whether it is a canvas. */
export type ThumbnailOf = Pick<ArtifactSummary, 'id' | 'version' | 'pages' | 'canvas'>

const isWebClient = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { kettu?: { client?: string } }).kettu?.client === 'web'

/** Max cached thumbnails and byte budget; older ones are evicted LRU and re-requested when visible. */
const KEPT_DESKTOP = 200
const KEPT_WEB = 40
const MAX_BYTES_DESKTOP = 32 * 1024 * 1024
const MAX_BYTES_WEB = 8 * 1024 * 1024
/** As many as main renders at once. */
const AT_ONCE = 3

interface CachedThumbnail {
  thumbnail: Thumbnail
  bytes: number
}

const made = new Map<string, CachedThumbnail>()
let cachedBytes = 0
const waiting: { key: string; id: string; run: () => Promise<Thumbnail> }[] = []
const listenersByKey = new Map<string, Set<() => void>>()
let asking = 0

const LOADING: Thumbnail = { state: 'loading' }

function keyOf(artifact: Pick<ArtifactSummary, 'id' | 'version'>): string {
  return `${artifact.id}:${artifact.version}`
}

function bytesOf(thumbnail: Thumbnail): number {
  return thumbnail.state === 'ready' ? thumbnail.src.length * 2 : 0
}

function notifyKey(key: string): void {
  const listeners = listenersByKey.get(key)
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}

function evict(key: string): void {
  const existing = made.get(key)
  if (!existing) return
  made.delete(key)
  cachedBytes -= existing.bytes
}

function settle(key: string, thumbnail: Thumbnail): void {
  evict(key)
  const bytes = bytesOf(thumbnail)
  const maxEntries = isWebClient() ? KEPT_WEB : KEPT_DESKTOP
  const maxBytes = isWebClient() ? MAX_BYTES_WEB : MAX_BYTES_DESKTOP
  made.set(key, { thumbnail, bytes })
  cachedBytes += bytes
  while ((made.size > maxEntries || cachedBytes > maxBytes) && made.size > 1) {
    const oldest = made.keys().next().value
    if (oldest === undefined || oldest === key) break
    evict(oldest)
    notifyKey(oldest)
  }
  notifyKey(key)
}

async function render(artifact: ThumbnailOf): Promise<Thumbnail> {
  let layout = null
  // The summary describes the latest version, so the files say which kind this version is.
  if (artifact.canvas || artifact.pages >= 2) {
    const { html, version, files } = await host('artifacts.read', {
      id: artifact.id,
      version: artifact.version,
    })
    if (version === artifact.version && files.some((f) => f.path === CANVAS_FILE)) {
      const { bytes } = await host('artifacts.file', {
        id: artifact.id,
        version,
        path: CANVAS_FILE,
      })
      layout = docThumbnailLayout(parseCanvasDoc(new TextDecoder().decode(bytes)))
      // A canvas with no page yet has nothing to show.
      if (!layout) return { state: 'failed' }
    } else if (version === artifact.version) layout = thumbnailLayout(parseCanvas(html))
  }
  const src = await window.kettu.artifacts.thumbnail(
    artifactRefOf(artifact.id),
    artifact.version,
    layout,
  )
  if (!src) return { state: 'failed' }
  if (!layout) return { state: 'ready', src, pages: null }
  const fit = fitThumbnail(layout)
  return {
    state: 'ready',
    src,
    pages: layout.map((p) => ({
      left: (fit.x + p.x * fit.scale) / THUMBNAIL_WIDTH,
      top: (fit.y + p.y * fit.scale) / THUMBNAIL_HEIGHT,
      width: (p.width * fit.scale) / THUMBNAIL_WIDTH,
      height: (p.height * fit.scale) / THUMBNAIL_HEIGHT,
      file: p.file,
    })),
  }
}

function pump(): void {
  if (asking >= AT_ONCE) return
  const next = waiting.shift()
  if (!next) return
  asking++
  next
    .run()
    .catch((error: unknown) => {
      console.warn(`Could not show a thumbnail of ${next.id}`, error)
      return { state: 'failed' } as const
    })
    .then((thumbnail) => settle(next.key, thumbnail))
    .finally(() => {
      asking--
      pump()
    })
  pump()
}

/** Queues a thumbnail, unless it is made or already waits. */
function ask(key: string, id: string, run: () => Promise<Thumbnail>): void {
  if (made.has(key) || waiting.some((w) => w.key === key)) return
  waiting.push({ key, id, run })
  pump()
}

/** A card that left the view before its turn waits no more. */
function drop(key: string): void {
  const at = waiting.findIndex((w) => w.key === key)
  if (at >= 0) waiting.splice(at, 1)
}

function subscribeKey(key: string, listener: () => void): () => void {
  let set = listenersByKey.get(key)
  if (!set) {
    set = new Set()
    listenersByKey.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listenersByKey.delete(key)
  }
}

/** The card's thumbnail, asked for while `inView`. */
export function useThumbnail(artifact: ThumbnailOf, inView: boolean): Thumbnail {
  const key = keyOf(artifact)
  const thumbnail = useSyncExternalStore(
    (listener) => subscribeKey(key, listener),
    () => made.get(key)?.thumbnail ?? LOADING,
  )
  useEffect(() => {
    if (!inView) return
    ask(key, artifact.id, () => render(artifact))
    return () => drop(key)
    // The key names the version; the rest of the summary does not change what renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, inView])
  return thumbnail
}

/**
 * The thumbnail of one frame, one slide, or a document in one theme, asked for while `inView`; it
 * fails at once where the host draws none.
 */
export function usePartThumbnail(
  id: string,
  version: number,
  part: ThumbnailPart,
  inView: boolean,
): Thumbnail {
  const key = `${id}:${version}:${JSON.stringify(part)}`
  const thumbnail = useSyncExternalStore(
    (listener) => subscribeKey(key, listener),
    () => made.get(key)?.thumbnail ?? LOADING,
  )
  useEffect(() => {
    if (!inView) return
    ask(key, id, async () => {
      const src = await window.kettu.artifacts.partThumbnail(artifactRefOf(id), version, part)
      return src ? { state: 'ready', src, pages: null } : { state: 'failed' }
    })
    return () => drop(key)
    // The key names the part.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, inView])
  return thumbnail
}

/** Test-only helper to inspect or clear the thumbnail cache. */
export const _thumbnailsCacheForTests = {
  size: () => made.size,
  bytes: () => cachedBytes,
  settleForTest: (key: string, thumbnail: Thumbnail) => settle(key, thumbnail),
  clear: () => {
    made.clear()
    cachedBytes = 0
    waiting.length = 0
    listenersByKey.clear()
  },
}
