// Limits of the attachments a message carries, checked in the composer and again by the host.
// See docs/design/session-model.md#attachments.

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
