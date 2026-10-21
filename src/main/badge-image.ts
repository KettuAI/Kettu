// Draws the Windows taskbar overlay badge, a count on a red disc, as PNG at any size, so the
// app ships no image per count and the badge stays sharp at every display scale.

import { deflate } from 'node:zlib'
import { promisify } from 'node:util'

type Point = [number, number]
type Stroke = Point[]

// The same red as the macOS Dock badge, so the count looks alike on both platforms.
const DISC = [0xff, 0x3b, 0x30] as const
const INK = [0xff, 0xff, 0xff] as const

const GLYPH_WIDTH = 0.6 // of the glyph height

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const steps = Math.max(4, Math.ceil(Math.abs(to - from) / 15))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = ((from + ((to - from) * i) / steps) * Math.PI) / 180
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)] as Point
  })
}

// Stroke centerlines in a box GLYPH_WIDTH wide and 1 high, y pointing down; angles in degrees
// with 0 to the right and 90 down.
const GLYPHS: Record<string, Stroke[]> = {
  '0': [arc(0.3, 0.5, 0.22, 0.4, 0, 360)],
  '1': [
    [
      [0.14, 0.22],
      [0.34, 0.1],
      [0.34, 0.9],
    ],
  ],
  '2': [[...arc(0.3, 0.32, 0.22, 0.22, 200, 400), [0.08, 0.9], [0.52, 0.9]]],
  '3': [arc(0.28, 0.29, 0.2, 0.19, 210, 450), arc(0.28, 0.69, 0.23, 0.21, 270, 510)],
  '4': [
    [
      [0.42, 0.9],
      [0.42, 0.1],
      [0.06, 0.66],
      [0.56, 0.66],
    ],
  ],
  '5': [[[0.5, 0.1], [0.14, 0.1], [0.12, 0.46], ...arc(0.3, 0.64, 0.22, 0.26, 235, 515)]],
  '6': [arc(0.3, 0.66, 0.22, 0.24, 0, 360), arc(0.5, 0.62, 0.42, 0.52, 180, 260)],
  '7': [
    [
      [0.06, 0.1],
      [0.54, 0.1],
      [0.22, 0.9],
    ],
  ],
  '8': [arc(0.3, 0.29, 0.19, 0.19, 0, 360), arc(0.3, 0.69, 0.23, 0.21, 0, 360)],
  '9': [arc(0.3, 0.34, 0.22, 0.24, 0, 360), arc(0.1, 0.38, 0.42, 0.52, 0, 80)],
  '+': [
    [
      [0.3, 0.27],
      [0.3, 0.73],
    ],
    [
      [0.07, 0.5],
      [0.53, 0.5],
    ],
  ],
}

/** The text of the badge: 1 to 9, then "9+"; null when there is nothing to show. */
export function badgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null
  return count > 9 ? '9+' : String(Math.floor(count))
}

function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Straight (not premultiplied) RGBA pixels of a `size` x `size` badge. */
export function renderBadge(label: string, size: number): Buffer {
  const glyphHeight = size * (label.length > 1 ? 0.46 : 0.56)
  const glyphWidth = glyphHeight * GLYPH_WIDTH
  const gap = glyphHeight * 0.04
  const textWidth = label.length * glyphWidth + (label.length - 1) * gap
  const left = (size - textWidth) / 2
  const top = (size - glyphHeight) / 2
  const halfStroke = (glyphHeight * 0.17) / 2
  const segments: [Point, Point][] = []
  ;[...label].forEach((char, index) => {
    const x0 = left + index * (glyphWidth + gap)
    for (const stroke of GLYPHS[char] ?? []) {
      const points = stroke.map(([x, y]) => [x0 + x * glyphHeight, top + y * glyphHeight] as Point)
      for (let i = 1; i < points.length; i++) segments.push([points[i - 1], points[i]])
    }
  })

  const pixels = Buffer.alloc(size * size * 4)
  const center = size / 2
  const radius = size / 2 - 0.25
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const disc = clamp01(radius - Math.hypot(px - center, py - center) + 0.5)
      if (disc === 0) continue
      let nearest = Infinity
      for (const [a, b] of segments) nearest = Math.min(nearest, distanceToSegment(px, py, a, b))
      const ink = clamp01(halfStroke - nearest + 0.5)
      const offset = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(DISC[channel] + (INK[channel] - DISC[channel]) * ink)
      }
      pixels[offset + 3] = Math.round(disc * 255)
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const deflateAsync = promisify(deflate)

/** Encodes straight RGBA pixels as an 8-bit RGBA PNG. */
export async function encodePng(rgba: Buffer, width: number, height: number): Promise<Buffer> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', await deflateAsync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
