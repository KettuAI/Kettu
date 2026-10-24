// Card thumbnails, asked for as cards scroll into view, one at a time in that order. Main renders
// and keeps them on disk; this keeps the ones shown in this run. See
// docs/design/artifacts.md#thumbnails.

import { useEffect, useSyncExternalStore } from 'react'
import { fitThumbnail, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@shared/artifacts'
import type { ArtifactSummary } from '@shared/artifacts'
import { host } from '@renderer/lib/host'
import { parseCanvas, thumbnailLayout } from './canvas'

/** A canvas's pages in its thumbnail, as shares of its width and height, for their outlines. */
export interface PageBox {
  left: number
  top: number
  width: number
  height: number
}

export type Thumbnail =
  | { state: 'loading' }
  | { state: 'ready'; src: string; pages: PageBox[] | null }
  | { state: 'failed' }

/** About two hundred cards' worth of images; older ones are asked for again. */
const KEPT = 200

const made = new Map<string, Thumbnail>()
const waiting: { key: string; artifact: ArtifactSummary }[] = []
const listeners = new Set<() => void>()
let busy = false

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

async function render(artifact: ArtifactSummary): Promise<Thumbnail> {
  let layout = null
  if (artifact.pages >= 2) {
    const { html, version } = await host('artifacts.read', {
      id: artifact.id,
      version: artifact.version,
    })
    if (version === artifact.version) layout = thumbnailLayout(parseCanvas(html))
  }
  const src = await window.overbench.artifacts.thumbnail(artifact.id, artifact.version, layout)
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
    })),
  }
}

function pump(): void {
  if (busy) return
  const next = waiting.shift()
  if (!next) return
  busy = true
  render(next.artifact)
    .catch((error: unknown) => {
      console.warn(`Could not show a thumbnail of ${next.artifact.id}`, error)
      return { state: 'failed' } as const
    })
    .then((thumbnail) => settle(next.key, thumbnail))
    .finally(() => {
      busy = false
      pump()
    })
}

/** Queues the card's thumbnail, unless it is made or already waits. */
function ask(artifact: ArtifactSummary): void {
  const key = keyOf(artifact)
  if (made.has(key) || waiting.some((w) => w.key === key)) return
  waiting.push({ key, artifact })
  pump()
}

/** A card that left the view before its turn waits no more. */
function drop(artifact: ArtifactSummary): void {
  const at = waiting.findIndex((w) => w.key === keyOf(artifact))
  if (at >= 0) waiting.splice(at, 1)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The card's thumbnail, asked for while `inView`. */
export function useThumbnail(artifact: ArtifactSummary, inView: boolean): Thumbnail {
  const key = keyOf(artifact)
  const thumbnail = useSyncExternalStore(subscribe, () => made.get(key) ?? LOADING)
  useEffect(() => {
    if (!inView) return
    ask(artifact)
    return () => drop(artifact)
    // The key names the version; the rest of the summary does not change what renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, inView])
  return thumbnail
}
