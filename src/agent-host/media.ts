// Grants for media files a thread names, which main then serves on the media scheme.

import { randomBytes } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mediaKindOfName,
  mediaUrl,
  type MediaAudioType,
  type MediaGrantRecord,
  type MediaImageType,
  type MediaOpenResult,
  type MediaVideoType,
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

export type AvType =
  { kind: 'audio'; mimeType: MediaAudioType } | { kind: 'video'; mimeType: MediaVideoType }

const audio = (mimeType: MediaAudioType): AvType => ({ kind: 'audio', mimeType })
const video = (mimeType: MediaVideoType): AvType => ({ kind: 'video', mimeType })

// ISO base media brands that hold pictures, not sound or video.
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'mif1', 'msf1'])

/** An EBML element's size or ID, a variable-length integer; null when cut or too long. */
function vint(b: Buffer, at: number): { value: number; length: number } | null {
  const first = b[at]
  if (first === undefined || first === 0) return null
  const length = Math.clz32(first) - 23
  if (length > 8 || at + length > b.length) return null
  let value = first & (0xff >> length)
  for (let i = 1; i < length; i++) value = value * 256 + b[at + i]!
  return { value, length }
}

/** The DocType of an EBML header, `webm` or `matroska`, read from its first element. */
function ebmlDocType(b: Buffer): string | null {
  const header = vint(b, 4)
  if (!header) return null
  const end = Math.min(b.length, 4 + header.length + header.value)
  let at = 4 + header.length
  while (at + 2 < end) {
    const id = b.readUInt16BE(at)
    const size = vint(b, at + 2)
    if (!size) return null
    const start = at + 2 + size.length
    if (id === 0x4282) return b.toString('latin1', start, Math.min(end, start + size.value))
    at = start + size.value
  }
  return null
}

/**
 * Audio or video by the container's first bytes, never the name. The name settles only what the
 * bytes leave open: an MP4 or WebM container holds either, and an ID3 tag fronts MP3 or AAC.
 */
export function avType(b: Buffer, name: string): AvType | null {
  const ascii = (start: number, end: number) => b.toString('latin1', start, end)
  const named = mediaKindOfName(name)
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (IMAGE_BRANDS.has(brand)) return null
    if (brand === 'qt  ') return video('video/quicktime')
    if (/^M4[ABP] $/.test(brand) || named === 'audio') return audio('audio/mp4')
    return video('video/mp4')
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
    const docType = ebmlDocType(b)
    if (docType === 'webm') return named === 'audio' ? audio('audio/webm') : video('video/webm')
    return docType === 'matroska' ? video('video/x-matroska') : null
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return audio('audio/wav')
  if (ascii(0, 4) === 'OggS') return audio('audio/ogg')
  if (ascii(0, 4) === 'fLaC') return audio('audio/flac')
  if (ascii(0, 3) === 'ID3') return audio(/\.aac$/i.test(name) ? 'audio/aac' : 'audio/mpeg')
  if (b.length >= 3 && b[0] === 0xff) {
    // ADTS: sync, MPEG version, layer 0.
    if ((b[1]! & 0xf6) === 0xf0) return audio('audio/aac')
    // An MPEG audio frame: sync, a version and a layer that are not reserved, a valid bitrate.
    const frame =
      (b[1]! & 0xe0) === 0xe0 &&
      ((b[1]! >> 3) & 3) !== 1 &&
      ((b[1]! >> 1) & 3) !== 0 &&
      b[2]! >> 4 !== 15
    if (frame) return audio('audio/mpeg')
  }
  return null
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
   * A grant for the media file `written` names, as a thread writes it. `root` is the session's
   * canonical folder; a file outside it needs `sessionId`'s thread to name it, and is not
   * looked at until it does.
   */
  async open(root: string, written: string, sessionId: string): Promise<MediaOpenResult> {
    let named: boolean | undefined
    const allowed = async (file: string) =>
      this.inside(root, file) || (named ??= await this.deps.names(sessionId, written))
    const candidates = this.candidates(root, written)
    let real: string | null = null
    let refused = candidates.length === 0
    for (const candidate of candidates) {
      if (!(await allowed(candidate))) {
        refused = true
        continue
      }
      try {
        real = await realpath(candidate)
        break
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    if (real === null) return { kind: refused ? 'forbidden' : 'not_found' }
    // A link inside the folder can lead out of it.
    if (!(await allowed(real))) return { kind: 'forbidden' }
    const info = await stat(real)
    if (!info.isFile()) return { kind: 'not_found' }
    const name = this.paths.basename(real)
    const nominated = mediaKindOfName(name)
    if (!nominated) return { kind: 'not_media' }
    const head = await readHead(real, Math.min(info.size, HEAD_BYTES))
    const type = nominated === 'image' ? imageOf(head) : avType(head, name)
    if (!type) return { kind: 'not_media' }
    const token = mediaToken((this.deps.random ?? randomBytes)(16))
    this.deps.grant({ token, path: real, mimeType: type.mimeType, sessionId })
    return {
      kind: 'granted',
      grant: {
        url: mediaUrl(token, name, info.mtimeMs),
        ...type,
        size: info.size,
        ...(type.kind === 'image' ? (pixelSize(type.mimeType, head) ?? {}) : {}),
      },
    }
  }

  /**
   * Where `written` may lie: as written, then percent-decoded, as some agents write spaces.
   * Network and device paths are never tried, since opening one would reach out to its host.
   */
  private candidates(root: string, written: string): string[] {
    const windows = this.deps.platform === 'win32'
    const local = (value: string) => (windows && /^[\\/]{2}/.test(value) ? null : value)
    const resolve = (value: string): string | null => {
      if (/^file:/i.test(value)) {
        // The URL parser turns `localhost` into no host.
        const url = URL.parse(value)
        if (!url || url.hostname !== '') return null
        try {
          return local(fileURLToPath(url, { windows }))
        } catch {
          return null
        }
      }
      const home = /^~[\\/]/.test(value) && (windows || value[1] === '/')
      if (home) return this.paths.join(this.deps.homeDir, value.slice(2))
      if (isAbsolutePath(value, this.deps.platform)) return local(value)
      // On Windows `\x` and `C:x` depend on the host's current drive and folder.
      if (windows && /^(?:[\\/]|[a-z]:)/i.test(value)) return null
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

function imageOf(head: Buffer): { kind: 'image'; mimeType: MediaImageType } | null {
  const mimeType = imageType(head) ?? (isSvg(head) ? 'image/svg+xml' : null)
  return mimeType ? { kind: 'image', mimeType } : null
}

async function readHead(file: string, length: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    return await readBytes(handle, length)
  } finally {
    await handle.close()
  }
}
