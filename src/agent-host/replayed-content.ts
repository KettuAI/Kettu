// A replayed user message's attachments. Agents replay a message's files and images in forms of
// their own, and the mappers turn those forms back into the attachment refs a sent message holds.

import type { Attachment, UserContent } from '@shared/thread'
import { t } from './i18n'
import type { MapperOutput } from './session-updates'

/** Appends parsed parts to user content, merging adjacent text. */
export function appendContent(
  content: UserContent[],
  parts: readonly UserContent[],
): UserContent[] {
  const out = [...content]
  for (const part of parts) {
    const last = out[out.length - 1]
    if (part.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: last.text + part.text }
    } else {
      out.push(part)
    }
  }
  return out
}

const FILE_LINK = /\[@([^\]]*)\]\(([^)]+)\)/g
const CONTEXT_AFTER = /^\s*<context ref="([^"]*)">[\s\S]*?<\/context>/
const CONTEXT_ONLY = /^\s*<context ref="([^"]*)">[\s\S]*?<\/context>\s*$/
const DATA_IMAGE = /^data:([^;,]+);base64,([\s\S]+)$/

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A `file:` URI's last path segment, decoded, for a resource that carries no name. */
export function fileBaseName(uri: string): string {
  const path = safeDecode(uri.replace(/^file:\/\//, ''))
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name || path
}

/** Bytes a base64 payload holds, without decoding it. */
export function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

export function replayedAttachment(
  entryId: string,
  index: number,
  fields: Omit<Attachment, 'id' | 'thumb' | 'blob'>,
): Attachment {
  return { id: `${entryId}:a${index}`, thumb: null, blob: null, ...fields }
}

export function attachmentCount(content: readonly UserContent[]): number {
  let count = 0
  for (const item of content) {
    if (item.type === 'ref' && item.ref.kind === 'attachment') count++
  }
  return count
}

export function imageCount(content: readonly UserContent[]): number {
  let count = 0
  for (const item of content) {
    if (
      item.type === 'ref' &&
      item.ref.kind === 'attachment' &&
      item.ref.attachment.type === 'image'
    )
      count++
  }
  return count
}

/** Widens the cut to the whole line when a removed form sits alone on it. */
function lineCut(text: string, start: number, end: number): { start: number; end: number } {
  let from = start
  let to = end
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) {
    // The form takes its own line, and the line break that ended the one before goes with it.
    from = lineStart > 0 ? lineStart - 1 : 0
  }
  const lineEnd = text.indexOf('\n', end)
  if (lineEnd !== -1 && /^[ \t]*$/.test(text.slice(end, lineEnd))) to = lineEnd + 1
  return { start: from, end: to }
}

/**
 * Splits one replayed text block into the text that stays and the attachments it holds: a file
 * link, with the `<context>` block that follows it when the refs match, and a `data:` image link.
 * Anything else stays text, so a text that only looks like one of the forms is not lost.
 */
export function parseReplayedText(
  text: string,
  entryId: string,
  existing: readonly UserContent[],
  out: MapperOutput,
): UserContent[] | null {
  const parts: UserContent[] = []
  let attachments = attachmentCount(existing)
  let images = imageCount(existing)
  let cursor = 0
  let found = false
  const push = (value: string): void => {
    if (value !== '') parts.push({ type: 'text', text: value })
  }
  FILE_LINK.lastIndex = 0
  for (let match = FILE_LINK.exec(text); match; match = FILE_LINK.exec(text)) {
    const [whole, label, uri] = match
    const start = match.index
    if (uri.startsWith('file:')) {
      const after = text.slice(start + whole.length)
      const context = CONTEXT_AFTER.exec(after)
      const embedded = context?.[1] === uri
      const end = embedded ? start + whole.length + context![0].length : start + whole.length
      const cut = lineCut(text, start, end)
      push(text.slice(cursor, cut.start))
      attachments++
      parts.push({
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: replayedAttachment(entryId, attachments, {
            type: 'file',
            name: safeDecode(label) || fileBaseName(uri),
            uri,
            mimeType: null,
            size: null,
            sent: embedded ? 'embedded' : 'linked',
          }),
        },
      })
      cursor = cut.end
      found = true
      if (embedded) FILE_LINK.lastIndex = cut.end
      continue
    }
    const image = DATA_IMAGE.exec(uri)
    if (!image || !image[1]!.startsWith('image/')) continue
    const cut = lineCut(text, start, start + whole.length)
    push(text.slice(cursor, cut.start))
    attachments++
    const name =
      label.trim().toLowerCase() === 'image'
        ? t('content.image', { number: ++images })
        : safeDecode(label)
    const attachment = replayedAttachment(entryId, attachments, {
      type: 'image',
      name,
      uri: null,
      mimeType: image[1]!,
      size: base64Size(image[2]!),
      sent: 'image',
    })
    parts.push({ type: 'ref', ref: { kind: 'attachment', attachment } })
    out.effects.push({
      kind: 'replayImage',
      entryId,
      attachmentId: attachment.id,
      mimeType: image[1]!,
      data: image[2]!,
    })
    cursor = cut.end
    found = true
    FILE_LINK.lastIndex = cut.end
  }
  if (!found) return null
  push(text.slice(cursor))
  return parts
}

/**
 * A chunk that is only a `<context>` block follows the link it belongs to in its own chunk, as
 * Claude Code replays one, and makes that linked file embedded.
 */
export function upgradeContext(
  content: readonly UserContent[],
  text: string,
): UserContent[] | null {
  const context = CONTEXT_ONLY.exec(text)
  if (!context) return null
  const uri = context[1]!
  const index = content.length - 1
  const item = content[index]
  if (item?.type !== 'ref' || item.ref.kind !== 'attachment') return null
  const attachment = item.ref.attachment
  if (attachment.type !== 'file' || attachment.sent !== 'linked' || attachment.uri !== uri) {
    return null
  }
  const next = [...content]
  next[index] = {
    type: 'ref',
    ref: { kind: 'attachment', attachment: { ...attachment, sent: 'embedded' } },
  }
  return next
}
