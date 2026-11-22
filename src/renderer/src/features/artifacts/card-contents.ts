// What a canvas or a deck holds, for its card: a canvas's pages with their frames in reading
// order, a deck's slides. Read from a version once its card is in view, a couple at a time, and
// kept, since a version never changes.

import { useEffect, useSyncExternalStore } from 'react'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import { host } from '@renderer/lib/host'

export interface OutlineFrame {
  id: string
  width: number
  height: number
}

export type Outline =
  | { kind: 'canvas'; pages: { name: string; frames: OutlineFrame[] }[] }
  | { kind: 'slides'; slides: number }

/** About as many cards as a page of them keeps in view; older ones are read again. */
const KEPT = 200
const AT_ONCE = 2

/** null: it holds no outline, or could not be read. */
const read = new Map<string, Outline | null>()
const waiting: { key: string; run: () => Promise<Outline | null> }[] = []
const listeners = new Set<() => void>()
let reading = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function settle(key: string, outline: Outline | null): void {
  read.set(key, outline)
  if (read.size > KEPT) read.delete(read.keys().next().value!)
  for (const listener of listeners) listener()
}

function pump(): void {
  if (reading >= AT_ONCE) return
  const next = waiting.shift()
  if (!next) return
  reading++
  next
    .run()
    .catch(() => null)
    .then((outline) => settle(next.key, outline))
    .finally(() => {
      reading--
      pump()
    })
  pump()
}

async function text(id: string, version: number, path: string): Promise<string> {
  const { bytes } = await host('artifacts.file', { id, version, path })
  return new TextDecoder().decode(bytes)
}

async function outlineOf(id: string, version: number, kind: 'canvas' | 'slides') {
  if (kind === 'slides') {
    const { parseDeck } = await import('@shared/artifact-slides')
    const parsed = parseDeck(await text(id, version, CONTENT_ENTRIES.slides))
    return 'deck' in parsed ? { kind: 'slides' as const, slides: parsed.deck.slides.length } : null
  }
  const doc = parseCanvasDoc(await text(id, version, CANVAS_FILE))
  const pages = doc.canvases
    .map((sheet) => ({
      name: sheet.name,
      frames: doc.pages
        .filter((page) => page.canvas === sheet.id)
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((page) => ({ id: page.id, width: page.width, height: page.height })),
    }))
    .filter((page) => page.frames.length > 0)
  return pages.length > 0 ? { kind: 'canvas' as const, pages } : null
}

/**
 * The outline of a canvas document's or a deck's version, asked for once `enabled`: undefined
 * while it is read, null for any other artifact or when it cannot be read.
 */
export function useOutline(
  id: string,
  version: number,
  kind: 'canvas' | 'slides' | null,
  enabled: boolean,
): Outline | null | undefined {
  const key = kind ? `${id}:${version}:${kind}` : null
  const outline = useSyncExternalStore(subscribe, () => (key ? read.get(key) : null))
  useEffect(() => {
    if (!enabled || !key || !kind || read.has(key) || waiting.some((w) => w.key === key)) return
    waiting.push({ key, run: () => outlineOf(id, version, kind) })
    pump()
    return () => {
      const at = waiting.findIndex((w) => w.key === key)
      if (at >= 0) waiting.splice(at, 1)
    }
  }, [id, version, kind, key, enabled])
  return outline
}
