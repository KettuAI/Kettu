// Media an agent names by path, served to the renderer on a scheme of its own.

export const MEDIA_SCHEME = 'kettu-media'

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

export const MEDIA_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
] as const

export type MediaAudioType = (typeof MEDIA_AUDIO_TYPES)[number]

export const MEDIA_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const

export type MediaVideoType = (typeof MEDIA_VIDEO_TYPES)[number]

export type MediaType = MediaImageType | MediaAudioType | MediaVideoType

const MEDIA_TYPES: ReadonlySet<string> = new Set([
  ...MEDIA_IMAGE_TYPES,
  ...MEDIA_AUDIO_TYPES,
  ...MEDIA_VIDEO_TYPES,
])

/** Whether a value is a type the scheme serves, as a grant from the host must carry. */
export function isMediaType(value: unknown): value is MediaType {
  return typeof value === 'string' && MEDIA_TYPES.has(value)
}

export type MediaKind = 'image' | 'audio' | 'video'

/** A file's name that nominates it as an image; its first bytes decide. */
export const MEDIA_IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
export const MEDIA_AUDIO_NAME = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i
export const MEDIA_VIDEO_NAME = /\.(mp4|m4v|webm|mov|mkv)$/i

/** The kind a file's name nominates it as, or null when it names no media. */
export function mediaKindOfName(name: string): MediaKind | null {
  if (MEDIA_IMAGE_NAME.test(name)) return 'image'
  if (MEDIA_VIDEO_NAME.test(name)) return 'video'
  if (MEDIA_AUDIO_NAME.test(name)) return 'audio'
  return null
}

export interface MediaGrant {
  url: string // kettu-media://<token>/<file name>?v=<mtime>
  kind: MediaKind
  mimeType: MediaType // from the first bytes, never the name
  size: number // bytes
  width?: number // pixels, when the header holds them
  height?: number
}

/** `media.open`: a grant, or why there is none. */
export type MediaOpenResult =
  | { kind: 'granted'; grant: MediaGrant }
  | { kind: 'not_found' } // no such regular file
  | { kind: 'forbidden' } // outside the session's folder, and the thread does not name it
  | { kind: 'not_media' } // not named as media, or its bytes are no media

/** What main keeps for a grant and serves on its token. */
export interface MediaGrantRecord {
  token: string
  path: string // the real path when granted; a request finds the same one or nothing
  mimeType: MediaType
  sessionId: string | null
}

/** The token of a media URL, or null when it is none. */
export function mediaUrlToken(url: string): string | null {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== `${MEDIA_SCHEME}:`) return null
  return MEDIA_TOKEN.test(parsed.hostname) ? parsed.hostname : null
}

export function mediaUrl(token: string, name: string, mtimeMs: number): string {
  return `${MEDIA_SCHEME}://${token}/${encodeURIComponent(name)}?v=${Math.trunc(mtimeMs)}`
}

/** The most bytes of carried media main takes for one copy or save. */
export const CARRIED_MEDIA_BYTES = 20 * 1024 * 1024

/** Media the thread carries as bytes, for a copy or a save; `name` is what a save suggests. */
export interface CarriedMedia {
  bytes: Uint8Array
  mimeType: string
  name: string
}
