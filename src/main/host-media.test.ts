import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MediaReadParams } from '@shared/remote/streams'
import { tempFolder } from '../agent-host/testing/temp'
import { HostMedia, PART_BYTES } from './host-media'

const studio = 'a'.repeat(32)

/** A host holding one file of `bytes`, which counts the reads main makes of it. */
function host(initial: Uint8Array) {
  let bytes = initial
  const reads: MediaReadParams[] = []
  let refuse = false
  const media = new HostMedia(
    async (hostId, params) => {
      expect(hostId).toBe(studio)
      reads.push(params)
      if (refuse) return { kind: 'forbidden' }
      const offset = params.offset ?? 0
      if (offset > bytes.length) throw { code: 'invalid_params', message: 'past the end' }
      const length = Math.min(params.length ?? bytes.length, bytes.length - offset)
      return {
        kind: 'granted',
        media: { name: 'demo.mp4', kind: 'video', mimeType: 'video/mp4', size: bytes.length },
        offset,
        length,
        bytes: bytes.slice(offset, offset + length).buffer,
      }
    },
    (size) => Buffer.alloc(size, 7),
  )
  const grant = media.grant(
    { hostId: studio, projectPath: '/srv/app', path: 'out/demo.mp4', sessionId: 's1' },
    { name: 'demo.mp4', kind: 'video', mimeType: 'video/mp4', size: bytes.length },
  )
  return {
    media,
    grant,
    record: media.byUrl(grant.url)!,
    reads,
    refuse: () => (refuse = true),
    rewrite: (next: Uint8Array) => (bytes = next),
  }
}

const file = (size: number) => new Uint8Array(size).map((_, i) => i % 251)

const get = (url: string, range?: string) =>
  new Request(url, range ? { headers: { range } } : undefined)

describe('HostMedia', () => {
  it('grants a URL on the media scheme, the same one for the same file', () => {
    const t = host(file(10))
    expect(t.grant).toEqual({
      url: expect.stringMatching(/^kettu-media:\/\/[a-z2-7]{26}\/demo\.mp4\?v=10$/),
      kind: 'video',
      mimeType: 'video/mp4',
      size: 10,
    })
    const again = t.media.grant(
      { hostId: studio, projectPath: '/srv/app', path: 'out/demo.mp4', sessionId: 's1' },
      { name: 'demo.mp4', kind: 'video', mimeType: 'video/mp4', size: 10 },
    )
    expect(again.url).toBe(t.grant.url)
    expect(t.media.byUrl('kettu-media://abc/x')).toBeNull()
  })

  it('reads only the range a player asks for, a part at a time', async () => {
    const bytes = file(PART_BYTES * 3)
    const t = host(bytes)
    const from = PART_BYTES * 2 - 10
    const response = await t.media.respond(get(t.grant.url, `bytes=${from}-`), t.record)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(
      `bytes ${from}-${bytes.length - 1}/${bytes.length}`,
    )
    expect(response.headers.get('content-type')).toBe('video/mp4')
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body).toEqual(bytes.slice(from))
    expect(t.reads).toEqual([
      {
        projectPath: '/srv/app',
        path: 'out/demo.mp4',
        sessionId: 's1',
        offset: from,
        length: PART_BYTES,
      },
      {
        projectPath: '/srv/app',
        path: 'out/demo.mp4',
        sessionId: 's1',
        offset: from + PART_BYTES,
        length: 10,
      },
    ])
  })

  it('serves the whole file without a range, and refuses one past its end', async () => {
    const bytes = file(1000)
    const t = host(bytes)
    const whole = await t.media.respond(get(t.grant.url), t.record)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('1000')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes)
    const past = await t.media.respond(get(t.grant.url, 'bytes=2000-'), t.record)
    expect(past.status).toBe(416)
  })

  it('takes the range against the size the file has now', async () => {
    const t = host(file(100))
    t.rewrite(file(50))
    const response = await t.media.respond(get(t.grant.url, 'bytes=-20'), t.record)
    expect(response.headers.get('content-range')).toBe('bytes 30-49/50')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(file(50).slice(30))
  })

  it('answers 404 once the host no longer grants the file', async () => {
    const t = host(file(10))
    t.refuse()
    expect((await t.media.respond(get(t.grant.url), t.record)).status).toBe(404)
  })

  it('reads the whole file for a copy, up to a bound, and saves it part by part', async () => {
    const bytes = file(PART_BYTES + 5)
    const t = host(bytes)
    expect(await t.media.readAll(t.record, PART_BYTES * 2)).toEqual(bytes)
    await expect(t.media.readAll(t.record, PART_BYTES)).rejects.toThrow(/too large/)
    const dir = await tempFolder('kettu-host-media-')
    const to = path.join(dir, 'demo.mp4')
    await t.media.saveTo(t.record, to)
    expect(new Uint8Array(await readFile(to))).toEqual(bytes)
  })

  it('leaves nothing behind when a save fails', async () => {
    const t = host(file(10))
    t.refuse()
    const dir = await tempFolder('kettu-host-media-')
    const to = path.join(dir, 'demo.mp4')
    await expect(t.media.saveTo(t.record, to)).rejects.toThrow()
    await expect(stat(to)).rejects.toThrow()
  })
})
