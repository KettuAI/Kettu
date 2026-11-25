// A Kettu plugin's icon: `assets/icon.png`, `.webp` or `.jpg` in its package, told apart by its
// bytes rather than its name. One the Marketplace shows is square, 256 to 1024 px a side and at
// most 512 KB. SVG is never read, since it can carry scripts.

import { MARKET_ICON_LIMITS, type MarketIconType } from '@shared/market-publish'

/** The files a package's icon is read from, in order, with the type each must be. */
export const ICON_FILES: readonly (readonly [string, MarketIconType])[] = [
  ['assets/icon.png', 'image/png'],
  ['assets/icon.webp', 'image/webp'],
  ['assets/icon.jpg', 'image/jpeg'],
]

const NAMES: Record<MarketIconType, string> = {
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/jpeg': 'JPEG',
}

export type IconCheck =
  { ok: true; type: MarketIconType; width: number; height: number } | { ok: false; reason: string }

const ascii = (data: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...data.subarray(at, at + length))

const u16be = (data: Uint8Array, at: number): number => (data[at]! << 8) | data[at + 1]!
const u16le = (data: Uint8Array, at: number): number => data[at]! | (data[at + 1]! << 8)
const u24le = (data: Uint8Array, at: number): number =>
  data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16)
const u32be = (data: Uint8Array, at: number): number =>
  ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The image type the bytes start as; null for anything else, SVG included. */
export function iconType(data: Uint8Array): MarketIconType | null {
  if (data.length >= 24 && PNG.every((byte, i) => data[i] === byte)) return 'image/png'
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 16 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (ascii(data, 12, 4) !== 'IHDR') return null
  return { width: u32be(data, 16), height: u32be(data, 20) }
}

function webpSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 30) return null
  const chunk = ascii(data, 12, 4)
  if (chunk === 'VP8 ') {
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null
    return { width: u16le(data, 26) & 0x3fff, height: u16le(data, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) return null
    const [b0, b1, b2, b3] = [data[21]!, data[22]!, data[23]!, data[24]!]
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    }
  }
  if (chunk === 'VP8X') return { width: 1 + u24le(data, 24), height: 1 + u24le(data, 27) }
  return null
}

// The start-of-frame markers, which carry the size: C0 to CF but for DHT, JPG and DAC.
const isFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  let at = 2
  while (at + 3 < data.length) {
    if (data[at] !== 0xff) return null
    const marker = data[at + 1]!
    // A fill byte before the marker.
    if (marker === 0xff) {
      at++
      continue
    }
    // The markers that stand alone, with no length after them.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    // The image data or its end, which no frame's size comes after.
    if (marker === 0xd9 || marker === 0xda) return null
    const length = u16be(data, at + 2)
    if (length < 2) return null
    if (isFrame(marker)) {
      if (at + 9 > data.length) return null
      return { width: u16be(data, at + 7), height: u16be(data, at + 5) }
    }
    at += 2 + length
  }
  return null
}

/** The size the image's header gives, in pixels; null when it gives none Kettu reads. */
export function iconSize(
  data: Uint8Array,
  type: MarketIconType,
): { width: number; height: number } | null {
  const size =
    type === 'image/png' ? pngSize(data) : type === 'image/webp' ? webpSize(data) : jpegSize(data)
  return size && size.width > 0 && size.height > 0 ? size : null
}

/** Whether text that starts as markup, such as an SVG image, is what the bytes are. */
function isMarkup(data: Uint8Array): boolean {
  const head = new TextDecoder().decode(data.subarray(0, 512)).trimStart().toLowerCase()
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg')
}

/**
 * Whether bytes are an icon the Marketplace shows, of `type` as its file name or listing says:
 * that image type by its header, square, 256 to 1024 px a side and at most 512 KB. A refusal
 * says why in a phrase that follows the file's name.
 */
export function checkIcon(data: Uint8Array, type: MarketIconType): IconCheck {
  const { bytes, min, max } = MARKET_ICON_LIMITS
  if (data.length === 0) return { ok: false, reason: 'is empty' }
  if (data.length > bytes) {
    return {
      ok: false,
      reason: `is ${Math.ceil(data.length / 1024)} KB, over the ${bytes / 1024} KB limit`,
    }
  }
  const found = iconType(data)
  if (found === null) {
    return {
      ok: false,
      reason: isMarkup(data)
        ? 'is an SVG or other markup file, which Kettu does not read as an icon'
        : 'is not a PNG, WebP or JPEG image',
    }
  }
  if (found !== type) {
    return { ok: false, reason: `is a ${NAMES[found]} image, not ${NAMES[type]}` }
  }
  const size = iconSize(data, found)
  if (!size)
    return { ok: false, reason: `has no size Kettu can read in its ${NAMES[found]} header` }
  const { width, height } = size
  if (width !== height) return { ok: false, reason: `is ${width} x ${height} px, not square` }
  if (width < min || width > max) {
    return {
      ok: false,
      reason: `is ${width} x ${height} px, not between ${min} and ${max} px`,
    }
  }
  return { ok: true, type: found, width, height }
}

export function iconDataUrl(data: Uint8Array, type: MarketIconType): string {
  return `data:${type};base64,${Buffer.from(data).toString('base64')}`
}
