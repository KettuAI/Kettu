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
  return embedsText(attachment) ? (attachment.size ?? 0) : 0
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
