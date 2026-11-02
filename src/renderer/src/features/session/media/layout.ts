// How a block lays out the media it names, and what a file card says of a file it cannot show.

import { mediaKindOfName, type MediaKind } from '@shared/media'

/** The most tiles a grid shows; the last of them counts the pictures it leaves out. */
export const GRID_TILES = 3

export type MediaRow = { kind: 'one'; path: string } | { kind: 'grid'; paths: string[] }

/**
 * A block's media in its order, two or more pictures as one grid where the first of them stands.
 * A file's name nominates it as a picture; clips and sounds keep a row each.
 */
export function mediaRows(paths: readonly string[]): MediaRow[] {
  const pictures = paths.filter((path) => mediaKindOfName(path) === 'image')
  if (pictures.length < 2) return paths.map((path) => ({ kind: 'one', path }))
  const first = paths.findIndex((path) => mediaKindOfName(path) === 'image')
  const rows: MediaRow[] = []
  paths.forEach((path, i) => {
    if (mediaKindOfName(path) !== 'image') rows.push({ kind: 'one', path })
    else if (i === first) rows.push({ kind: 'grid', paths: pictures })
  })
  return rows
}

/** The pictures a grid shows as tiles, and how many more the last tile stands for. */
export function gridTiles(paths: readonly string[]): { tiles: string[]; more: number } {
  const tiles = paths.slice(0, GRID_TILES)
  return { tiles, more: paths.length - tiles.length }
}

/** The longest type a 34 px tile fits at its 9 px. */
const TYPE_CHARS = 5

/**
 * The type a file card's tile names, in capitals: the file's extension, else its MIME subtype,
 * such as `mp4` of `video/mp4`; null when neither is short enough to fit.
 */
export function fileType(name: string, mimeType?: string): string | null {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  if (/^[a-z\d]+$/i.test(extension) && extension.length <= TYPE_CHARS) {
    return extension.toUpperCase()
  }
  const subtype = mimeType?.split('/')[1]?.replace(/^x-/, '').replace(/\+.*$/, '')
  return subtype && /^[a-z\d]+$/i.test(subtype) && subtype.length <= TYPE_CHARS
    ? subtype.toUpperCase()
    : null
}

/** Why a file the thread names shows as a card: too large, or a format Chromium cannot show. */
export type CardReason = 'tooLarge' | MediaKind

/** A card's reason, as its line of what is known says it. */
export const REASONS = {
  tooLarge: 'media.tooLargeShort',
  image: 'media.unsupportedShort',
  video: 'media.unsupportedPlayShort',
  audio: 'media.unsupportedPlayShort',
} as const satisfies Record<CardReason, string>
