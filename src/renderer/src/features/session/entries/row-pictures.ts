// The pictures a tool call carries or names, which its folded row shows as thumbnails.

import { mediaKindOfName } from '@shared/media'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { toolMedia } from '../media/named'
import { fileKey, refKey } from '../media/viewer-items'

/** A picture by the key the viewer knows it by, the same as in the call's details. */
export type RowPicture =
  | { kind: 'ref'; key: string; entryId: string; index: number; mimeType: string; data: string }
  | { kind: 'file'; key: string; entryId: string; path: string }

/** A call's pictures in the order its details show them: those it carries, else the files it names. */
export function entryPictures(entry: ToolEntry): RowPicture[] {
  const carried = entry.content.flatMap((content, index): RowPicture[] =>
    content.type === 'ref' && content.ref.kind === 'image'
      ? [
          {
            kind: 'ref',
            key: refKey(entry.id, index),
            entryId: entry.id,
            index,
            mimeType: content.ref.mimeType,
            data: content.ref.data,
          },
        ]
      : [],
  )
  const named = toolMedia(entry)
    .filter((path) => mediaKindOfName(path) === 'image')
    .map((path): RowPicture => ({
      kind: 'file',
      key: fileKey(entry.id, path),
      entryId: entry.id,
      path,
    }))
  return [...carried, ...named]
}

/** The pictures of a row's steps in thread order; a thought has none. */
export function stepPictures(entries: readonly (ThreadEntry | undefined)[]): RowPicture[] {
  return entries.flatMap((entry) => (entry?.kind === 'tool' ? entryPictures(entry) : []))
}
