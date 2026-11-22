// What an update to an artifact changed, worked out by comparing two of its versions' files: a
// canvas's frames, a document's sections, a deck's slides, or else the files themselves.

import { useEffect, useState } from 'react'
import type { ArtifactContent } from '@shared/artifacts'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import { host } from '@renderer/lib/host'

export interface ChangedFrame {
  id: string
  name: string
  file: string
}

export type Changes =
  | { kind: 'frames'; frames: ChangedFrame[] }
  | { kind: 'files'; paths: string[] }
  /** Each section by its heading; null for the text before the first one. */
  | { kind: 'sections'; headings: (string | null)[] }
  /** Each slide by its number, from 1. */
  | { kind: 'slides'; slides: { number: number; title: string | null }[] }

/** About as many cards as a long thread scrolls past; older ones are worked out again. */
const KEPT = 200

// A version never changes once written, so each pair is worked out once.
const reads = new Map<string, { changes: Changes | null | undefined; done: Promise<void> }>()

/**
 * What changed from version `from` to `to`, once `enabled`: undefined while it is worked out, null
 * when it cannot be, as for an older host whose files carry no hash, or when nothing changed.
 */
export function useChanges(
  id: string,
  from: number | null,
  to: number | null,
  enabled: boolean,
): Changes | null | undefined {
  const key = from !== null && to !== null && from < to ? `${id}:${from}:${to}` : null
  const [, setDone] = useState(0)
  useEffect(() => {
    if (!enabled || key === null) return
    let read = reads.get(key)
    if (!read) {
      const next = { changes: undefined as Changes | null | undefined, done: Promise.resolve() }
      next.done = changesBetween(id, from!, to!).then(
        (changes) => void (next.changes = changes),
        (error: unknown) => {
          console.warn(`Could not compare versions ${from} and ${to} of ${id}`, error)
          next.changes = null
        },
      )
      reads.set(key, next)
      if (reads.size > KEPT) reads.delete(reads.keys().next().value!)
      read = next
    }
    let live = true
    void read.done.then(() => live && setDone((n) => n + 1))
    return () => {
      live = false
    }
  }, [id, from, to, key, enabled])
  return key === null ? null : reads.get(key)?.changes
}

async function changesBetween(id: string, from: number, to: number): Promise<Changes | null> {
  const [before, after] = await Promise.all([
    host('artifacts.read', { id, version: from }),
    host('artifacts.read', { id, version: to }),
  ])
  if (before.version !== from || after.version !== to) return null
  const paths = changedPaths(before, after)
  if (!paths || paths.length === 0) return null
  const changed = new Set(paths)
  const text = async (version: number, path: string) => {
    const { bytes } = await host('artifacts.file', { id, version, path })
    return new TextDecoder().decode(bytes)
  }
  const has = (content: ArtifactContent, path: string) => content.files.some((f) => f.path === path)

  if (has(after, CANVAS_FILE)) {
    const doc = parseCanvasDoc(await text(to, CANVAS_FILE))
    const frames = doc.pages
      .filter((page) => changed.has(page.file))
      .map((page) => ({ id: page.id, name: page.name, file: page.file }))
    if (frames.length > 0) return { kind: 'frames', frames }
  }
  const type = after.type?.name
  if (type === 'document' && changed.has('document.md') && has(before, 'document.md')) {
    const headings = await changedSections(
      await text(from, 'document.md'),
      await text(to, 'document.md'),
    )
    if (headings.length > 0) return { kind: 'sections', headings }
  }
  if (type === 'slides' && changed.has('slides.json') && has(before, 'slides.json')) {
    const slides = await changedSlides(
      await text(from, 'slides.json'),
      await text(to, 'slides.json'),
    )
    if (slides && slides.length > 0) return { kind: 'slides', slides }
  }
  return { kind: 'files', paths }
}

/** The files added, removed or changed, the new version's first; null when a hash is missing. */
function changedPaths(before: ArtifactContent, after: ArtifactContent): string[] | null {
  if ([...before.files, ...after.files].some((f) => !f.hash)) return null
  const old = new Map(before.files.map((f) => [f.path, f.hash]))
  const kept = new Set(after.files.map((f) => f.path))
  return [
    ...after.files.filter((f) => old.get(f.path) !== f.hash).map((f) => f.path),
    ...before.files.filter((f) => !kept.has(f.path)).map((f) => f.path),
  ]
}

const HEADING = /^(?:ATX|Setext)Heading\d$/

interface Section {
  heading: string | null
  text: string
}

/** The document's sections: each heading with what follows it up to the next heading. */
async function sectionsOf(markdown: string): Promise<Section[]> {
  const { markdownBlocks } = await import('@shared/artifact-document')
  const sections: Section[] = []
  let current: Section = { heading: null, text: '' }
  let start = 0
  for (const block of markdownBlocks(markdown)) {
    if (!HEADING.test(block.kind)) continue
    current.text = markdown.slice(start, block.from)
    if (current.heading !== null || current.text.trim() !== '') sections.push(current)
    const line = markdown.slice(block.from, block.to).split('\n')[0]!
    current = {
      heading: line
        .replace(/^\s*#{1,6}\s*/, '')
        .replace(/\s+#+\s*$/, '')
        .trim(),
      text: '',
    }
    start = block.from
  }
  current.text = markdown.slice(start)
  if (current.heading !== null || current.text.trim() !== '') sections.push(current)
  return sections
}

/** The sections added, changed or removed, matched by heading and, for repeated ones, by turn. */
async function changedSections(before: string, after: string): Promise<(string | null)[]> {
  const keyed = (sections: Section[]) => {
    const seen = new Map<string, number>()
    return sections.map((section) => {
      const name = section.heading ?? ''
      const n = seen.get(name) ?? 0
      seen.set(name, n + 1)
      return { key: `${name}\u0000${n}`, section }
    })
  }
  const old = keyed(await sectionsOf(before))
  const now = keyed(await sectionsOf(after))
  const oldText = new Map(old.map(({ key, section }) => [key, section.text.trim()]))
  const kept = new Set(now.map(({ key }) => key))
  return [
    ...now.filter(({ key, section }) => oldText.get(key) !== section.text.trim()),
    ...old.filter(({ key }) => !kept.has(key)),
  ].map(({ section }) => section.heading)
}

/** The new deck's slides that differ from the old one's at the same place; null if one fails. */
async function changedSlides(
  before: string,
  after: string,
): Promise<{ number: number; title: string | null }[] | null> {
  const { parseDeck } = await import('@shared/artifact-slides')
  const old = parseDeck(before)
  const now = parseDeck(after)
  if (!('deck' in old) || !('deck' in now)) return null
  return now.deck.slides.flatMap((slide, i) =>
    JSON.stringify(slide) === JSON.stringify(old.deck.slides[i])
      ? []
      : [{ number: i + 1, title: 'title' in slide && slide.title ? slide.title : null }],
  )
}
