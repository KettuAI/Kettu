// What a request about a selection carries: its chips, its words and the picture of the element.

import type { CommentAnchor } from '@shared/artifact-comments'
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
 * A picture of the element a request is about: its frame or page, cut around it with its outline
 * drawn in, base64 PNG; null where nothing can draw it.
 */
export async function elementPicture(input: {
  artifactId: string
  version: number
  /** The frame's file and size, or the page at the width it shows. */
  file: string | null
  width: number
  height: number
  box: PageBox | null
}): Promise<string | null> {
  const { box } = input
  const height = box
    ? Math.min(8_000, Math.max(input.height, box.y + box.height + 80))
    : input.height
  const image = await window.kettu.artifacts
    .pageImage(
      artifactRefOf(input.artifactId),
      input.version,
      input.file ? { group: 0, index: 1, file: input.file } : null,
      { width: Math.round(input.width), height: Math.round(height) },
    )
    .catch(() => null)
  if (!image || !box) return image
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/png;base64,${image}`)).blob(),
  )
  const scale = bitmap.width / input.width
  const pad = 48
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const w = Math.min(input.width - x, box.width + 2 * pad)
  const h = Math.min(height - y, box.height + 2 * pad)
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
  ctx.strokeRect((box.x - x) * scale, (box.y - y) * scale, box.width * scale, box.height * scale)
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

/** The request about one element or the whole artifact: the words, the anchor as data, a picture. */
export function anchorMessage(
  selected: { artifactId: string; title: string; anchor: CommentAnchor },
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

/** The chip of one anchor. */
export function anchorChip(anchor: CommentAnchor): AskChip {
  return { key: `${anchor.path}:${anchor.offset ?? ''}`, label: anchorLabel(anchor) }
}
