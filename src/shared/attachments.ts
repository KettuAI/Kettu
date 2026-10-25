// Limits of the attachments a message carries, checked in the composer and again by the host,
// and the rules both use to tell how an attachment is sent.

/** Attachments in one prompt. */
export const ATTACHMENT_LIMIT = 20

/** All of a prompt, counted as sent: its text, and its images in base64. */
export const PROMPT_BYTES = 10 * 1024 * 1024

/** An attachment's share of `PROMPT_BYTES`: base64 is a third larger than the bytes. */
export function sentBytes(size: number): number {
  return Math.ceil((size * 4) / 3)
}

/** An image larger than this on a side is scaled to fit it before it is sent. */
export const IMAGE_SIDE = 2000

/** An image file larger than this is scaled too: 5 MB once in base64, every model's limit. */
export const IMAGE_BYTES = 3.75 * 1024 * 1024

/** The most bytes the host takes for one attachment it is handed. */
export const ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Thumbnails are this many pixels on their longer side, twice the 112 px tile. */
export const THUMB_SIDE = 224

/** A thumbnail's data URL is never longer than this. */
export const THUMB_CHARS = 256 * 1024

/** The image types every model takes as images; others are re-encoded first. */
export const MODEL_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

/** A text file up to this size goes with its contents, about what an agent's own file read takes. */
export const EMBED_BYTES = 256 * 1024

// Besides text/*, the types the host gives a file it found to be text.
const TEXT_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh',
  'image/svg+xml',
])

/** Whether the host found a file of this type to be text. */
export function isTextType(mimeType: string | null): boolean {
  return mimeType !== null && (mimeType.startsWith('text/') || TEXT_TYPES.has(mimeType))
}

interface Sendable {
  type: 'image' | 'file' | 'folder' | 'text'
  mimeType: string | null
  size: number | null
}

/** Whether a file goes with its contents to an agent that takes embedded context. */
export function embedsText(attachment: Sendable): boolean {
  return (
    attachment.type === 'file' &&
    isTextType(attachment.mimeType) &&
    attachment.size !== null &&
    attachment.size <= EMBED_BYTES
  )
}

/** An attachment's share of `PROMPT_BYTES`: an image in base64 and a text, but not a link. */
export function promptShare(attachment: Sendable): number {
  if (attachment.type === 'image') return sentBytes(attachment.size ?? 0)
  if (attachment.type === 'text') return attachment.size ?? 0
  return embedsText(attachment) ? (attachment.size ?? 0) : 0
}

/** A paste longer than this, in characters, becomes a pasted text attachment. */
export const PASTED_TEXT_CHARS = 10_000

const PREVIEW_LINES = 3

// Far wider than a tile shows, so the thumb stays small whatever the text's lines are.
const PREVIEW_LINE_CHARS = 120

const TEXT_THUMB = /^data:text\/plain;charset=utf-8;lines=(\d+),(.*)$/s

/** A text's lines, not counting the empty one after a final line break. */
export function lineCount(text: string): number {
  if (text === '') return 0
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0
  return /[\r\n]$/.test(text) ? breaks : breaks + 1
}

/**
 * A pasted text's thumb: its first three lines and its line count as a text/plain data URL, so a
 * restored draft and the thread show its tile without reading its bytes.
 */
export function textThumb(text: string): string {
  const lines = text
    .split(/\r\n|\r|\n/, PREVIEW_LINES)
    .map((line) => line.slice(0, PREVIEW_LINE_CHARS))
  return `data:text/plain;charset=utf-8;lines=${lineCount(text)},${encodeURIComponent(lines.join('\n'))}`
}

/** What a pasted text's thumb holds, or null when it is not one. */
export function readTextThumb(thumb: string | null): { lines: string[]; count: number } | null {
  const match = thumb ? TEXT_THUMB.exec(thumb) : null
  if (!match) return null
  try {
    return { lines: decodeURIComponent(match[2]!).split('\n'), count: Number(match[1]) }
  } catch {
    return null
  }
}

/** A file or folder main granted the host for one attachment, as the renderer knows it. */
export interface GrantedAttachment {
  grantId: string
  name: string
  kind: 'file' | 'folder'
  /** A file's bytes when it was granted; null for a folder. */
  size: number | null
}

/** What main hands the host: the path behind a grant, which the renderer never sees. */
export interface AttachmentGrant {
  grantId: string
  path: string
  kind: 'file' | 'folder'
}
