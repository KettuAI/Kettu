// What a request about a selection carries: its chips, its words and the picture of the element.

import type { CommentAnchor } from '@shared/artifact-comments'
import { unionPageBoxes } from '@shared/artifact-runtime/marquee'
import type { PageBox } from '@shared/artifact-runtime/page-messages'
import type { UserContent } from '@shared/thread'
import { artifactRefOf } from '@renderer/lib/host'
import { anchorLabel, selectionPrompt } from './anchors'
import { accent } from './editor'

/** What the request goes with, as a chip: a frame, an element, or the whole artifact. */
export interface AskChip {
  key: string
  label: string
}

/** The words and pictures of a request, built when it is sent. */
export type AskMessage = (ask: string) => Promise<{ text: string; images: UserContent[] }>

/**
 * A picture of the element(s) a request is about: its frame or page, cut around the union of
 * selected elements with each outline drawn in, base64 PNG; null where nothing can draw it.
 */
export async function elementPicture(input: {
  artifactId: string
  version: number
  /** The frame's file and size, or the page at the width it shows. */
  file: string | null
  width: number
  height: number
  box?: PageBox | null
  boxes?: readonly PageBox[]
}): Promise<string | null> {
  const targets = input.boxes && input.boxes.length > 0 ? input.boxes : input.box ? [input.box] : []
  const union = unionPageBoxes(targets)
  const height = union
    ? Math.min(8_000, Math.max(input.height, union.y + union.height + 80))
    : input.height
  const image = await window.kettu.artifacts
    .pageImage(
      artifactRefOf(input.artifactId),
      input.version,
      input.file ? { group: 0, index: 1, file: input.file } : null,
      { width: Math.round(input.width), height: Math.round(height) },
    )
    .catch(() => null)
  if (!image || !union) return image
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${image}`)).blob(),
  )
  const scale = bitmap.width / input.width
  const pad = 48
  const x = Math.max(0, union.x - pad)
  const y = Math.max(0, union.y - pad)
  const w = Math.min(input.width - x, union.width + 2 * pad)
  const h = Math.min(height - y, union.height + 2 * pad)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return image
  ctx.drawImage(
    bitmap,
    x * scale,
    y * scale,
    w * scale,
    h * scale,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  ctx.strokeStyle = accent()
  ctx.lineWidth = 2 * scale
  for (const box of targets) {
    ctx.strokeRect((box.x - x) * scale, (box.y - y) * scale, box.width * scale, box.height * scale)
  }
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

/** The request about one or more elements or the whole artifact: the words, the anchors as data, a picture. */
export function anchorMessage(
  selected: { artifactId: string; title: string; anchor: CommentAnchor; others?: CommentAnchor[] },
  picture: () => Promise<string | null>,
): AskMessage {
  return async (ask) => {
    const text = selectionPrompt(ask, selected)
    const data = await picture().catch(() => null)
    return {
      text,
      images: data ? [{ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data } }] : [],
    }
  }
}

/** The chip of one anchor; `index` keeps keys unique when multiple script-created nodes share null offset. */
export function anchorChip(anchor: CommentAnchor, index?: number): AskChip {
  return {
    key:
      index === undefined
        ? `${anchor.path}:${anchor.offset ?? ''}`
        : `${anchor.path}:${anchor.offset ?? 'dyn'}:${index}`,
    label: anchorLabel(anchor),
  }
}
