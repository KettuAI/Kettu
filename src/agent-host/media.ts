// Grants for media files a thread names, which main then serves on the media scheme. See
// docs/design/media.md#granting-a-file.

import { randomBytes } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEDIA_IMAGE_NAME,
  mediaUrl,
  type MediaGrantRecord,
  type MediaImageType,
  type MediaOpenResult,
} from '@shared/media'
import type { Platform } from '@shared/platform'
import { imageType, readBytes } from './files'
import { isAbsolutePath, pathKey } from './paths'

/** Enough for any signature, and for a JPEG's frame header behind its metadata. */
const HEAD_BYTES = 64 * 1024
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export interface MediaServiceDeps {
  platform: Platform
  homeDir: string
  /** Whether an agent or user entry of the session's thread holds this text. */
  names(sessionId: string, text: string): Promise<boolean>
  /** Hands main a grant to serve. */
  grant(record: MediaGrantRecord): void
  /** For tests. */
  random?: (size: number) => Buffer
}

/** 128 random bits in base32, lowercase, so the token survives as a URL's host. */
export function mediaToken(bytes: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

// After an optional BOM, XML declaration, comments and doctype, the first element is `<svg`.
const SVG_START =
  /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)\s*)*<svg[\s/>]/i

export function isSvg(head: Buffer): boolean {
  return SVG_START.test(head.toString('utf8', 0, Math.min(head.length, 4096)))
}

export interface PixelSize {
  width: number
  height: number
}

function size(width: number, height: number): PixelSize | null {
  return width > 0 && height > 0 ? { width, height } : null
}

function webpSize(b: Buffer): PixelSize | null {
  if (b.length < 30) return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') return size(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21)
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === 'VP8X') return size(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1)
  return null
}

/** The Exif orientation in an APP1 segment's body, 1 when it has none. */
function exifOrientation(b: Buffer, start: number, end: number): number {
  if (b.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1
  const tiff = start + 6
  const little = b.toString('latin1', tiff, tiff + 2) === 'II'
  const u16 = (at: number) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at))
  const u32 = (at: number) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at))
  if (tiff + 8 > end) return 1
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return 1
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return 1
}

function jpegSize(b: Buffer): PixelSize | null {
  let orientation = 1
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    // End of image or start of scan: past the headers with no frame among them.
    if (marker === 0xd9 || marker === 0xda) return null
    // Markers without a length: the restart markers, start of image and TEM.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      at += 2
      continue
    }
    const length = b.readUInt16BE(at + 2)
    if (marker === 0xe1)
      orientation = exifOrientation(b, at + 4, Math.min(b.length, at + 2 + length))
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (frame) {
      if (at + 9 > b.length) return null
      const height = b.readUInt16BE(at + 5)
      const width = b.readUInt16BE(at + 7)
      // Orientations 5 to 8 turn the picture a quarter, and Chromium draws it turned.
      return orientation >= 5 && orientation <= 8 ? size(height, width) : size(width, height)
    }
    at += 2 + length
  }
  return null
}

/** The picture's size as its header gives it, or null when the header does not hold it here. */
export function pixelSize(mimeType: MediaImageType, b: Buffer): PixelSize | null {
  switch (mimeType) {
    case 'image/png':
      return b.length >= 24 ? size(b.readUInt32BE(16), b.readUInt32BE(20)) : null
    case 'image/gif':
      return b.length >= 10 ? size(b.readUInt16LE(6), b.readUInt16LE(8)) : null
    case 'image/bmp':
      return b.length >= 26 ? size(Math.abs(b.readInt32LE(18)), Math.abs(b.readInt32LE(22))) : null
    case 'image/webp':
      return webpSize(b)
    case 'image/jpeg':
      return jpegSize(b)
    default:
      return null
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export class MediaService {
  private readonly paths: path.PlatformPath

  constructor(private readonly deps: MediaServiceDeps) {
    this.paths = deps.platform === 'win32' ? path.win32 : path.posix
  }

  /**
   * A grant for the image `written` names, as a thread writes it. `root` is the session's
   * canonical folder; a file outside it needs `sessionId`'s thread to name it.
   */
  async open(root: string, written: string, sessionId: string): Promise<MediaOpenResult> {
    let real: string | null = null
    for (const candidate of this.candidates(root, written)) {
      try {
        real = await realpath(candidate)
        break
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    if (real === null) return { kind: 'not_found' }
    const info = await stat(real)
    if (!info.isFile()) return { kind: 'not_found' }
    if (!this.inside(root, real) && !(await this.deps.names(sessionId, written))) {
      return { kind: 'forbidden' }
    }
    const name = this.paths.basename(real)
    if (!MEDIA_IMAGE_NAME.test(name)) return { kind: 'not_media' }
    const head = await readHead(real, Math.min(info.size, HEAD_BYTES))
    const mimeType: MediaImageType | null =
      imageType(head) ?? (isSvg(head) ? 'image/svg+xml' : null)
    if (!mimeType) return { kind: 'not_media' }
    const token = mediaToken((this.deps.random ?? randomBytes)(16))
    this.deps.grant({ token, path: real, mimeType, sessionId })
    return {
      kind: 'granted',
      grant: {
        url: mediaUrl(token, name, info.mtimeMs),
        kind: 'image',
        mimeType,
        size: info.size,
        ...(pixelSize(mimeType, head) ?? {}),
      },
    }
  }

  /** Where `written` may lie: as written, then percent-decoded, as some agents write spaces. */
  private candidates(root: string, written: string): string[] {
    const resolve = (value: string): string | null => {
      if (/^file:/i.test(value)) {
        try {
          return fileURLToPath(value, { windows: this.deps.platform === 'win32' })
        } catch {
          return null
        }
      }
      const home = /^~[\\/]/.test(value) && (this.deps.platform === 'win32' || value[1] === '/')
      if (home) return this.paths.join(this.deps.homeDir, value.slice(2))
      if (isAbsolutePath(value, this.deps.platform)) return value
      return this.paths.resolve(root, value)
    }
    const found = [resolve(written)]
    if (written.includes('%') && !/^file:/i.test(written)) {
      try {
        found.push(resolve(decodeURI(written)))
      } catch {
        // Not valid percent-encoding, so only the path as written.
      }
    }
    return found.filter((value): value is string => value !== null)
  }

  private inside(root: string, real: string): boolean {
    const rootKey = pathKey(root, this.deps.platform)
    const prefix = rootKey.endsWith(this.paths.sep) ? rootKey : rootKey + this.paths.sep
    return pathKey(real, this.deps.platform).startsWith(prefix)
  }
}

async function readHead(file: string, length: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    return await readBytes(handle, length)
  } finally {
    await handle.close()
  }
}
