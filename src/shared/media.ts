// Media an agent names by path, served to the renderer on a scheme of its own. See
// docs/design/media.md.

export const MEDIA_SCHEME = 'overbench-media'

/** A grant's token, 128 random bits in base32: the host of its URL, so lowercase. */
export const MEDIA_TOKEN = /^[a-z2-7]{26}$/

/** The images the first version shows; SVG only ever as an image, so none of its scripts run. */
export const MEDIA_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/svg+xml',
] as const

export type MediaImageType = (typeof MEDIA_IMAGE_TYPES)[number]

/** A file's name that nominates it as an image; its first bytes decide. */
export const MEDIA_IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i

export interface MediaGrant {
  url: string // overbench-media://<token>/<file name>?v=<mtime>
  kind: 'image'
  mimeType: MediaImageType // from the first bytes, never the name
  size: number // bytes
  width?: number // pixels, when the header holds them
  height?: number
}

/** `media.open`: a grant, or why there is none. */
export type MediaOpenResult =
  | { kind: 'granted'; grant: MediaGrant }
  | { kind: 'not_found' } // no such regular file
  | { kind: 'forbidden' } // outside the session's folder, and the thread does not name it
  | { kind: 'not_media' } // not named as an image, or its bytes are no image

/** What main keeps for a grant and serves on its token. */
export interface MediaGrantRecord {
  token: string
  path: string // the real path when granted; a request finds the same one or nothing
  mimeType: MediaImageType
  sessionId: string | null
}

export function mediaUrl(token: string, name: string, mtimeMs: number): string {
  return `${MEDIA_SCHEME}://${token}/${encodeURIComponent(name)}?v=${Math.trunc(mtimeMs)}`
}
