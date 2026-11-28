// What a version of an artifact holds that a link in a reply can name: a canvas's frames, a
// document's sections, a deck's slides. Read once a link is hovered, and kept, since a version
// never changes.

import { useEffect, useSyncExternalStore } from 'react'
import type { ArtifactOutline } from '@shared/artifact-links'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import { host } from '@renderer/lib/host'

/** About as many as a long thread links to; older ones are read again. */
const KEPT = 100

/** null: it could not be read. */
const read = new Map<string, ArtifactOutline | null>()
const asked = new Set<string>()
const listeners = new Set<() => void>()

/** Clears cached artifact place outlines (e.g. after switching accounts). */
export function clearPlaceOutlineCache(): void {
  read.clear()
  asked.clear()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function text(id: string, version: number, path: string): Promise<string> {
  const { bytes } = await host('artifacts.file', { id, version, path })
  return new TextDecoder().decode(bytes)
}

async function outlineOf(
  id: string,
  version: number,
  kind: 'canvas' | 'document' | 'slides',
): Promise<ArtifactOutline> {
  if (kind === 'canvas') {
    const doc = parseCanvasDoc(await text(id, version, CANVAS_FILE))
    return { frames: doc.pages.map((p) => ({ id: p.id, name: p.name })) }
  }
  if (kind === 'slides') {
    const [{ parseDeck }, { slideTitle }] = await Promise.all([
      import('@shared/artifact-slides'),
      import('@shared/artifact-changes'),
    ])
    const parsed = parseDeck(await text(id, version, CONTENT_ENTRIES.slides))
    if (!('deck' in parsed)) return { slides: [] }
    return {
      slides: parsed.deck.slides.map((slide, i) => ({ number: i + 1, title: slideTitle(slide) })),
    }
  }
  const { documentSections } = await import('@shared/artifact-changes')
  const sections = documentSections(await text(id, version, CONTENT_ENTRIES.document))
  return { sections: sections.map((s) => ({ slug: s.slug, heading: s.heading })) }
}

/** The outline of an artifact's version, read now when it is not kept; null when it cannot be. */
export async function readPlaceOutline(
  id: string,
  version: number,
  kind: 'canvas' | 'document' | 'slides',
): Promise<ArtifactOutline | null> {
  const key = `${id}:${version}:${kind}`
  const kept = read.get(key)
  if (kept !== undefined) return kept
  const outline = await outlineOf(id, version, kind).catch(() => null)
  read.set(key, outline)
  if (read.size > KEPT) read.delete(read.keys().next().value!)
  for (const listener of listeners) listener()
  return outline
}

/**
 * The outline of an artifact's version, asked for once `enabled`: undefined while it is read,
 * null when it cannot be.
 */
export function usePlaceOutline(
  id: string,
  version: number | null,
  kind: 'canvas' | 'document' | 'slides' | null,
  enabled: boolean,
): ArtifactOutline | null | undefined {
  const key = version !== null && kind ? `${id}:${version}:${kind}` : null
  const outline = useSyncExternalStore(subscribe, () => (key ? read.get(key) : undefined))
  useEffect(() => {
    if (!enabled || !key || read.has(key) || asked.has(key)) return
    asked.add(key)
    outlineOf(id, version!, kind!)
      .catch(() => null)
      .then((outline) => {
        asked.delete(key)
        read.set(key, outline)
        if (read.size > KEPT) read.delete(read.keys().next().value!)
        for (const listener of listeners) listener()
      })
  }, [id, version, kind, key, enabled])
  return outline
}
