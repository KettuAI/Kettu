import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEDIA_TOKEN, type MediaGrantRecord } from '@shared/media'
import type { Platform } from '@shared/platform'
import { isSvg, MediaService, mediaToken, pixelSize } from './media'

const platform: Platform = process.platform
const posixOnly = platform === 'win32' ? it.skip : it

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

function gif(width: number, height: number): Buffer {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'latin1')
  head.writeUInt16LE(width, 6)
  head.writeUInt16LE(height, 8)
  return head
}

function bmp(width: number, height: number): Buffer {
  const head = Buffer.alloc(54)
  head.write('BM', 0, 'latin1')
  head.writeInt32LE(width, 18)
  head.writeInt32LE(height, 22)
  return head
}

function webpExtended(width: number, height: number): Buffer {
  const head = Buffer.alloc(30)
  head.write('RIFF', 0, 'latin1')
  head.write('WEBP', 8, 'latin1')
  head.write('VP8X', 12, 'latin1')
  head.writeUIntLE(width - 1, 24, 3)
  head.writeUIntLE(height - 1, 27, 3)
  return head
}

/** A JPEG header: an Exif segment with `orientation`, then a baseline frame of the given size. */
function jpeg(width: number, height: number, orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x0112, 10)
  tiff.writeUInt16BE(3, 12)
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(exif.length + 2, 2)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif, sof])
}

describe('mediaToken', () => {
  it('is 128 bits in lowercase base32', () => {
    expect(mediaToken(Buffer.alloc(16, 0xff))).toMatch(MEDIA_TOKEN)
    expect(mediaToken(Buffer.alloc(16))).toBe('a'.repeat(26))
  })
})

describe('pixelSize', () => {
  it('reads the size from the header of each format', () => {
    expect(pixelSize('image/png', png(2000, 1281))).toEqual({ width: 2000, height: 1281 })
    expect(pixelSize('image/gif', gif(320, 200))).toEqual({ width: 320, height: 200 })
    expect(pixelSize('image/bmp', bmp(64, -48))).toEqual({ width: 64, height: 48 })
    expect(pixelSize('image/webp', webpExtended(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    })
    expect(pixelSize('image/jpeg', jpeg(4000, 3000, 1))).toEqual({ width: 4000, height: 3000 })
  })

  it('turns a JPEG that its Exif orientation turns a quarter', () => {
    expect(pixelSize('image/jpeg', jpeg(4000, 3000, 6))).toEqual({ width: 3000, height: 4000 })
  })

  it('gives no size for a cut header or a format whose size is not at its start', () => {
    expect(pixelSize('image/png', png(10, 10).subarray(0, 20))).toBeNull()
    expect(pixelSize('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
    expect(pixelSize('image/svg+xml', Buffer.from('<svg/>'))).toBeNull()
  })
})

describe('isSvg', () => {
  it('takes SVG after a declaration, comments and a doctype', () => {
    const svg =
      '\uFEFF<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg xmlns="x"/>'
    expect(isSvg(Buffer.from(svg))).toBe(true)
    expect(isSvg(Buffer.from('<html><svg/></html>'))).toBe(false)
  })
})

describe('MediaService', () => {
  let base: string
  let root: string
  let home: string
  let outside: string
  const sessionId = 's1'

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(os.tmpdir(), 'overbench-media-')))
    root = join(base, 'scratch', 'scratch-1')
    home = join(base, 'home')
    outside = join(base, 'elsewhere')
    for (const dir of [join(root, 'out'), join(home, 'Desktop'), outside]) {
      await mkdir(dir, { recursive: true })
    }
    await writeFile(join(root, 'out', 'desktop shot.png'), png(2000, 1281))
    await writeFile(join(root, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(join(root, 'notes.png'), 'not a picture')
    await writeFile(join(root, 'notes.txt'), 'text')
    await writeFile(join(outside, 'chart.png'), png(10, 20))
    await writeFile(join(home, 'Desktop', 'a.gif'), gif(3, 4))
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function service(named: string[] = []) {
    const grants: MediaGrantRecord[] = []
    const asked: string[] = []
    const media = new MediaService({
      platform,
      homeDir: home,
      names: async (id, text) => {
        asked.push(text)
        return id === sessionId && named.includes(text)
      },
      grant: (record) => grants.push(record),
      random: () => Buffer.alloc(16, 7),
    })
    return { media, grants, asked }
  }

  it('grants an image in the session folder, with its size, by a relative path', async () => {
    const { media, grants, asked } = service()
    const result = await media.open(root, 'out/desktop shot.png', sessionId)
    const token = mediaToken(Buffer.alloc(16, 7))
    expect(result).toMatchObject({
      kind: 'granted',
      grant: { kind: 'image', mimeType: 'image/png', size: 33, width: 2000, height: 1281 },
    })
    if (result.kind !== 'granted') return
    expect(result.grant.url).toMatch(
      new RegExp(`^overbench-media://${token}/desktop%20shot\\.png\\?v=\\d+$`),
    )
    expect(grants).toEqual([
      {
        token,
        path: join(root, 'out', 'desktop shot.png'),
        mimeType: 'image/png',
        sessionId,
      },
    ])
    expect(asked).toEqual([])
  })

  it('takes absolute paths, file URIs and percent-encoded spaces', async () => {
    const { media } = service()
    const file = join(root, 'out', 'desktop shot.png')
    for (const written of [file, pathToFileURL(file).href, 'out/desktop%20shot.png']) {
      expect((await media.open(root, written, sessionId)).kind).toBe('granted')
    }
  })

  it('needs the thread to name a file outside the session folder', async () => {
    const file = join(outside, 'chart.png')
    expect(await service().media.open(root, file, sessionId)).toEqual({ kind: 'forbidden' })
    const named = service([file])
    expect((await named.media.open(root, file, sessionId)).kind).toBe('granted')
    expect(named.asked).toEqual([file])
  })

  it('resolves ~/ against the home folder', async () => {
    const { media } = service(['~/Desktop/a.gif'])
    expect(await media.open(root, '~/Desktop/a.gif', sessionId)).toMatchObject({
      kind: 'granted',
      grant: { mimeType: 'image/gif', width: 3, height: 4 },
    })
  })

  it('says what it is not', async () => {
    const { media, grants } = service()
    expect(await media.open(root, 'out/missing.png', sessionId)).toEqual({ kind: 'not_found' })
    expect(await media.open(root, 'out', sessionId)).toEqual({ kind: 'not_found' })
    expect(await media.open(root, 'notes.png', sessionId)).toEqual({ kind: 'not_media' })
    expect(await media.open(root, 'notes.txt', sessionId)).toEqual({ kind: 'not_media' })
    expect(grants).toEqual([])
  })

  it('grants SVG as an image, without a size', async () => {
    const result = await service().media.open(root, 'mark.svg', sessionId)
    expect(result).toMatchObject({ kind: 'granted', grant: { mimeType: 'image/svg+xml' } })
    if (result.kind === 'granted') expect(result.grant.width).toBeUndefined()
  })

  posixOnly('follows a link to where it leads before deciding', async () => {
    await symlink(join(outside, 'chart.png'), join(root, 'link.png'))
    expect(await service().media.open(root, 'link.png', sessionId)).toEqual({
      kind: 'forbidden',
    })
  })
})
