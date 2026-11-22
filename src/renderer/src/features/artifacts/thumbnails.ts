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

/** About two hundred cards' worth of images; older ones are asked for again. */
const KEPT = 200
/** As many as main renders at once. */
const AT_ONCE = 3

const made = new Map<string, Thumbnail>()
const waiting: { key: string; id: string; run: () => Promise<Thumbnail> }[] = []
const listeners = new Set<() => void>()
let asking = 0

const LOADING: Thumbnail = { state: 'loading' }

function keyOf(artifact: Pick<ArtifactSummary, 'id' | 'version'>): string {
  return `${artifact.id}:${artifact.version}`
}

function settle(key: string, thumbnail: Thumbnail): void {
  made.delete(key)
  made.set(key, thumbnail)
  if (made.size > KEPT) made.delete(made.keys().next().value!)
  for (const listener of listeners) listener()
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The card's thumbnail, asked for while `inView`. */
export function useThumbnail(artifact: ThumbnailOf, inView: boolean): Thumbnail {
  const key = keyOf(artifact)
  const thumbnail = useSyncExternalStore(subscribe, () => made.get(key) ?? LOADING)
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
  const thumbnail = useSyncExternalStore(subscribe, () => made.get(key) ?? LOADING)
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
