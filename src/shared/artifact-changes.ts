// What changed between two versions of an artifact, worked out from their content alike by the
// host and by every client: a canvas's frames, a web page's files, a document's sections and the
// passages in them, a deck's slides. Nothing here trusts a writer's own account of its change.

import { markdownBlocks } from './artifact-document'
import { headingSlug } from './artifact-links'
import { parseDeck, type Slide } from './artifact-slides'
import { CONTENT_ENTRIES, type ArtifactTypeName } from './artifact-types'
import { CANVAS_FILE, parseCanvasDoc } from './canvas-doc'

export interface ChangedFrame {
  /** The frame's id in the canvas document, which stays the same across versions. */
  id: string
  name: string
  /** Its HTML file. */
  file: string
}

/** A section of a document by its heading, null for the text before the first one. */
export interface ChangedSection {
  heading: string | null
  /** Its slug, as a link to it names it; null for the text before the first heading. */
  slug: string | null
  /** How many of its passages changed. */
  passages: number
}

/**
 * A top-level block of a document, such as a paragraph, a heading, a list or a table, that the
 * later version added, changed or no longer has. `from` and `to` are where it lies in the later
 * version's text; a removed block's are both where it was, between the blocks around it.
 */
export interface ChangedPassage {
  change: 'added' | 'changed' | 'removed'
  /** The slug of the section it is in, in the later version. */
  section: string | null
  from: number
  to: number
  /**
   * Where the block it replaces or removes lies in the earlier version's text, so its old words
   * can be shown beside the new ones; absent for an added block and from hosts before it.
   */
  before?: { from: number; to: number }
}

export interface ChangedSlide {
  /** From 1, in the later version. */
  number: number
  title: string | null
}

export type ArtifactChanges =
  | { kind: 'frames'; frames: ChangedFrame[] }
  | { kind: 'files'; paths: string[] }
  | {
      kind: 'sections'
      /** Each changed section's heading, as `sections` lists them. */
      headings: (string | null)[]
      sections: ChangedSection[]
      passages: ChangedPassage[]
    }
  | { kind: 'slides'; slides: ChangedSlide[] }

/** A version as a comparison needs it: its files with their hashes, and its type. */
export interface ComparedVersion {
  version: number
  files: readonly { path: string; hash?: string }[]
  type: ArtifactTypeName | null
}

/** Reads a text file of a version. */
export type ReadText = (version: number, path: string) => Promise<string>

/**
 * What changed from `before` to `after`, which may be any two versions of one artifact: null when
 * nothing did, or when it cannot be told, as for files an older host gives without hashes.
 */
export async function compareVersions(
  before: ComparedVersion,
  after: ComparedVersion,
  read: ReadText,
): Promise<ArtifactChanges | null> {
  const paths = changedPaths(before, after)
  if (!paths || paths.length === 0) return null
  const changed = new Set(paths)
  const has = (of: ComparedVersion, path: string) => of.files.some((f) => f.path === path)

  if (has(after, CANVAS_FILE)) {
    const frames = changedFrames(await read(after.version, CANVAS_FILE), changed)
    if (frames.length > 0) return { kind: 'frames', frames }
  }
  const type = after.type
  const entry = type ? CONTENT_ENTRIES[type] : null
  if (type === 'document' && entry && changed.has(entry) && has(before, entry)) {
    const document = compareDocuments(
      await read(before.version, entry),
      await read(after.version, entry),
    )
    if (document.sections.length > 0) return { kind: 'sections', ...document }
  }
  if (type === 'slides' && entry && changed.has(entry) && has(before, entry)) {
    const slides = compareDecks(await read(before.version, entry), await read(after.version, entry))
    if (slides && slides.length > 0) return { kind: 'slides', slides }
  }
  return { kind: 'files', paths }
}

/** The files added, removed or changed, the later version's first; null when a hash is missing. */
export function changedPaths(before: ComparedVersion, after: ComparedVersion): string[] | null {
  if ([...before.files, ...after.files].some((f) => !f.hash)) return null
  const old = new Map(before.files.map((f) => [f.path, f.hash]))
  const kept = new Set(after.files.map((f) => f.path))
  return [
    ...after.files.filter((f) => old.get(f.path) !== f.hash).map((f) => f.path),
    ...before.files.filter((f) => !kept.has(f.path)).map((f) => f.path),
  ]
}

/** The later canvas's frames whose files are among `changed`, in its paint order. */
export function changedFrames(canvasJson: string, changed: ReadonlySet<string>): ChangedFrame[] {
  const doc = parseCanvasDoc(canvasJson)
  return doc.pages
    .filter((page) => changed.has(page.file))
    .map((page) => ({ id: page.id, name: page.name, file: page.file }))
}

// Documents.

const HEADING = /^(?:ATX|Setext)Heading\d$/

/** A section of a document: a heading with what follows it up to the next heading. */
export interface DocumentSection {
  heading: string | null
  /** Unique in the document: a repeated heading's slug ends in -1, -2 and so on. */
  slug: string | null
  /** 1 to 6 for a heading; 0 for the text before the first one. */
  level: number
  from: number
  to: number
}

function headingText(markdown: string, from: number, to: number, kind: string): string {
  const source = markdown.slice(from, to)
  const line = kind.startsWith('Setext') ? source.split('\n')[0]! : source
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
}

/** The document's sections, in order; the text before the first heading is one when it has any. */
export function documentSections(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = []
  const used = new Map<string, number>()
  let current: DocumentSection = { heading: null, slug: null, level: 0, from: 0, to: 0 }
  const close = (end: number): void => {
    current.to = end
    if (current.heading !== null || markdown.slice(current.from, end).trim() !== '') {
      sections.push(current)
    }
  }
  for (const block of markdownBlocks(markdown)) {
    if (!HEADING.test(block.kind)) continue
    close(block.from)
    const heading = headingText(markdown, block.from, block.to, block.kind)
    const base = headingSlug(heading)
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    current = {
      heading,
      slug: n === 0 ? base : `${base}-${n}`,
      level: Number(block.kind.slice(-1)),
      from: block.from,
      to: block.to,
    }
  }
  close(markdown.length)
  return sections
}

/** Above this many pairs of blocks, the blocks between the unchanged ends all count as changed. */
const MAX_PAIRS = 1_000_000

interface Block {
  from: number
  to: number
  text: string
}

function blocksOf(markdown: string): Block[] {
  return markdownBlocks(markdown).map((b) => ({
    from: b.from,
    to: b.to,
    text: markdown.slice(b.from, b.to).trim(),
  }))
}

/** Which blocks of `a` and `b` are the same, as pairs of indexes in order: the longest such run. */
function matchBlocks(a: readonly Block[], b: readonly Block[]): [number, number][] {
  let start = 0
  while (start < a.length && start < b.length && a[start]!.text === b[start]!.text) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1]!.text === b[endB - 1]!.text) {
    endA--
    endB--
  }
  const pairs: [number, number][] = []
  for (let i = 0; i < start; i++) pairs.push([i, i])
  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && n * m <= MAX_PAIRS) {
    // The longest common subsequence of the middle, by the usual table.
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] =
          a[start + i]!.text === b[start + j]!.text
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i]!.text === b[start + j]!.text) {
        pairs.push([start + i, start + j])
        i++
        j++
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
      else j++
    }
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k])
  return pairs
}

/** The passages that changed from `before` to `after`, in the later version's order. */
export function changedPassages(before: string, after: string): ChangedPassage[] {
  const a = blocksOf(before)
  const b = blocksOf(after)
  const sections = documentSections(after)
  const sectionAt = (offset: number): string | null => {
    let slug: string | null = null
    for (const section of sections) {
      if (section.from > offset) break
      slug = section.slug
    }
    return slug
  }
  const passages: ChangedPassage[] = []
  const hunk = (fromA: number, toA: number, fromB: number, toB: number): void => {
    const removed = toA - fromA
    const added = toB - fromB
    for (let k = 0; k < added; k++) {
      const block = b[fromB + k]!
      const old = k < removed ? a[fromA + k]! : null
      passages.push({
        change: old ? 'changed' : 'added',
        section: sectionAt(block.from),
        from: block.from,
        to: block.to,
        ...(old ? { before: { from: old.from, to: old.to } } : {}),
      })
    }
    // What was removed without anything in its place lies between the blocks around it.
    const at = toB < b.length ? b[toB]!.from : after.length
    for (let k = added; k < removed; k++) {
      const old = a[fromA + k]!
      passages.push({
        change: 'removed',
        section: sectionAt(Math.max(0, at - 1)),
        from: at,
        to: at,
        before: { from: old.from, to: old.to },
      })
    }
  }
  let i = 0
  let j = 0
  for (const [ma, mb] of [...matchBlocks(a, b), [a.length, b.length] as [number, number]]) {
    if (ma > i || mb > j) hunk(i, ma, j, mb)
    i = ma + 1
    j = mb + 1
  }
  return passages
}

/**
 * The sections and passages that changed between two documents: each section of the later one
 * with a changed passage, then the sections the earlier one had and the later one does not.
 */
export function compareDocuments(
  before: string,
  after: string,
): Omit<Extract<ArtifactChanges, { kind: 'sections' }>, 'kind'> {
  const passages = changedPassages(before, after)
  const now = documentSections(after)
  const counts = new Map<string | null, number>()
  for (const passage of passages) {
    counts.set(passage.section, (counts.get(passage.section) ?? 0) + 1)
  }
  const sections: ChangedSection[] = now
    .filter((section) => counts.has(section.slug))
    .map((section) => ({
      heading: section.heading,
      slug: section.slug,
      passages: counts.get(section.slug)!,
    }))
  const kept = new Set(now.map((section) => section.slug))
  for (const section of documentSections(before)) {
    if (section.slug === null || kept.has(section.slug)) continue
    sections.push({ heading: section.heading, slug: section.slug, passages: 0 })
  }
  return { headings: sections.map((section) => section.heading), sections, passages }
}

// Decks.

export function slideTitle(slide: Slide): string | null {
  return 'title' in slide && slide.title ? slide.title : null
}

/** The later deck's slides that differ from the earlier one's at the same place; null if one fails. */
export function compareDecks(before: string, after: string): ChangedSlide[] | null {
  const old = parseDeck(before)
  const now = parseDeck(after)
  if (!('deck' in old) || !('deck' in now)) return null
  return now.deck.slides.flatMap((slide, i) =>
    JSON.stringify(slide) === JSON.stringify(old.deck.slides[i])
      ? []
      : [{ number: i + 1, title: slideTitle(slide) }],
  )
}
