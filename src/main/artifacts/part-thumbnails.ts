// What a thumbnail of one part of a version shows and the name it is kept under: a canvas frame,
// a slide, or a document in one theme. The name says what the image is drawn from, so a part a
// new version leaves alone keeps its image.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isHtmlPath } from '@shared/artifact-files'
import { parseDeck } from '@shared/artifact-slides'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import type { ThumbnailPart } from '@shared/artifacts'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import type { ArtifactContentFile, ArtifactContentResult } from '@shared/host-control'

export interface Size {
  width: number
  height: number
}

/** What a type's viewer draws for a part's thumbnail: one slide, or the document in one theme. */
export interface ViewerPart {
  slide?: number
  theme?: 'light' | 'dark'
}

/** How a content file of this computer is named: its hash. */
const CONTENT_FILE = /^([0-9a-f]{64})\.html$/

type FoundContent = Extract<ArtifactContentResult, { kind: 'found' }>

/** What a part's thumbnail renders, and the name it is kept under, which says what it shows. */
export type PartPlan = { name: string } & (
  { kind: 'frame'; file: string; size: Size } | { kind: 'viewer'; viewer: ViewerPart }
)

/** What a file holds: its hash, read from its name when it is this computer's, else its bytes'. */
async function contentKey(file: ArtifactContentFile): Promise<string> {
  const named = CONTENT_FILE.exec(path.basename(file.file))
  if (named) return named[1]!
  return createHash('sha256')
    .update(await readFile(file.file))
    .digest('hex')
}

function digest(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex')
}

/**
 * How to draw a part of a found version, or null when it has no such part. A frame is named by
 * its own file, the files every frame shares and its size; a slide by its own content, the deck's
 * look and its pictures; a document's theme by the version and the theme. A type's are named with
 * the app's version too, since its viewer comes with the app.
 */
export async function partPlan(
  found: FoundContent,
  part: ThumbnailPart,
  appVersion: string,
): Promise<PartPlan | null> {
  const byPath = new Map(found.files.map((file) => [file.path, file]))
  const text = async (filePath: string): Promise<string | null> => {
    const file = byPath.get(filePath)
    return file ? readFile(file.file, 'utf8') : null
  }
  if ('frame' in part) {
    const json = await text(CANVAS_FILE)
    if (json === null) return null
    const page = parseCanvasDoc(json).pages.find((p) => p.id === part.frame)
    const own = page ? byPath.get(page.file) : undefined
    if (!page || !own) return null
    const shared: string[] = []
    for (const file of found.files.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
      if (isHtmlPath(file.path) || file.path === CANVAS_FILE) continue
      shared.push(file.path, await contentKey(file))
    }
    const size = { width: page.width, height: page.height }
    return {
      kind: 'frame',
      file: page.file,
      size,
      name: digest(['frame', page.file, await contentKey(own), ...shared, size.width, size.height]),
    }
  }
  const type = found.type
  if (!type) return null
  if ('theme' in part) {
    if (type.name !== 'document') return null
    return {
      kind: 'viewer',
      viewer: { theme: part.theme },
      name: digest(['document', found.key, type.format, part.theme, appVersion]),
    }
  }
  if (type.name !== 'slides') return null
  const json = await text(CONTENT_ENTRIES.slides)
  const parsed = json === null ? null : parseDeck(json)
  if (!parsed || !('deck' in parsed)) return null
  const { deck } = parsed
  const slide = deck.slides[part.slide - 1]
  if (!slide) return null
  const pictures: string[] = []
  for (const value of Object.values(slide)) {
    const file = typeof value === 'string' ? byPath.get(value) : undefined
    if (file) pictures.push(file.path, await contentKey(file))
  }
  return {
    kind: 'viewer',
    viewer: { slide: part.slide },
    name: digest([
      'slide',
      JSON.stringify(slide),
      deck.theme ?? '',
      deck.aspect ?? '',
      ...pictures,
      type.format,
      appVersion,
    ]),
  }
}
