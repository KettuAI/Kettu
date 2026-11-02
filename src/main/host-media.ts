// Media of another host on main's media scheme. The host authorized the file once for its URL;
// each request on the URL is then read from the host one part at a time, every part a
// `media.read` of its own that the host checks again, so a player seeking in a video of any size
// fetches only what it plays, and copy and save read the file from the host the same way.

import { randomBytes } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import {
  mediaUrl,
  mediaUrlToken,
  type MediaFile,
  type MediaGrant,
  type MediaType,
} from '@shared/media'
import type { MediaReadParams } from '@shared/remote/streams'
import { mediaToken } from '../agent-host/media'
import type { HostMediaFile, HostMediaGrants } from './host-sessions'
import { parseRange } from './media'

/** The most one read asks of the host. */
export const PART_BYTES = 1024 * 1024

const MAX_GRANTS = 2_000

/** What main keeps for a URL: where the file is, as the host names it, and what it was then. */
export interface HostMediaRecord extends HostMediaFile {
  token: string
  name: string
  mimeType: MediaType
  size: number
}

/** A part of the file, as the host's link hands main its bytes. */
type Part =
  | { kind: 'granted'; media: { size: number }; offset: number; length: number; bytes: ArrayBuffer }
  | { kind: 'not_found' | 'forbidden' | 'not_media' }

export type ReadPart = (hostId: string, params: MediaReadParams) => Promise<unknown>

const HEADERS = {
  'Accept-Ranges': 'bytes',
  // Safe for any origin: the request filter, not CORS, decides who may read, the app's page alone.
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...HEADERS, ...headers } })
}

export class HostMedia implements HostMediaGrants {
  private readonly byToken = new Map<string, HostMediaRecord>()
  /** The token of each file as it was granted, so asking again keeps its URL. */
  private readonly byFile = new Map<string, string>()

  constructor(
    private readonly read: ReadPart,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {}

  grant(file: HostMediaFile, media: Omit<MediaFile, 'path'>): MediaGrant {
    const key = JSON.stringify([
      file.hostId,
      file.projectPath,
      file.path,
      file.sessionId,
      media.mimeType,
      media.size,
    ])
    let token = this.byFile.get(key)
    if (!token || !this.byToken.has(token)) {
      token = mediaToken(this.random(16))
      this.byFile.set(key, token)
    }
    const record: HostMediaRecord = {
      hostId: file.hostId,
      projectPath: file.projectPath,
      path: file.path,
      sessionId: file.sessionId,
      token,
      name: media.name,
      mimeType: media.mimeType,
      size: media.size,
    }
    this.byToken.delete(token)
    this.byToken.set(token, record)
    for (const old of this.byToken.keys()) {
      if (this.byToken.size <= MAX_GRANTS) break
      this.byToken.delete(old)
    }
    if (this.byFile.size > MAX_GRANTS * 2) {
      for (const [k, t] of this.byFile) if (!this.byToken.has(t)) this.byFile.delete(k)
    }
    return {
      // The size stands in for a version: a file rewritten to another size gets a new URL.
      url: mediaUrl(token, media.name, media.size),
      kind: media.kind,
      mimeType: media.mimeType,
      size: media.size,
      ...(media.width === undefined ? {} : { width: media.width }),
      ...(media.height === undefined ? {} : { height: media.height }),
    }
  }

  find(token: string): HostMediaRecord | null {
    return this.byToken.get(token) ?? null
  }

  /** The record behind a media URL, or null when it is no URL of another host's media. */
  byUrl(url: unknown): HostMediaRecord | null {
    const token = typeof url === 'string' ? mediaUrlToken(url) : null
    return token ? this.find(token) : null
  }

  /** Answers a request on the media scheme for one of these URLs. */
  async respond(request: Request, record: HostMediaRecord): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405)
    const header = request.headers.get('range')
    let size = record.size
    // The first part says how large the file is now; a file that changed is read again by it.
    for (let tries = 0; tries < 2; tries++) {
      const range = parseRange(header, size)
      if (range === 'unsatisfiable') return answer(416, { 'Content-Range': `bytes */${size}` })
      const { start, end } = range ?? { start: 0, end: size - 1 }
      // A range past the end of a file that shrank fails; reading none of it says its size.
      const first =
        (await this.part(record, start, Math.min(PART_BYTES, end - start + 1)).catch(() => null)) ??
        (await this.part(record, 0, 0).catch(() => null))
      if (!first) return answer(502)
      if (first.kind !== 'granted') return answer(404)
      if (first.media.size !== size) {
        size = record.size = first.media.size
        continue
      }
      const headers: Record<string, string> = {
        ...HEADERS,
        'Content-Type': record.mimeType,
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      }
      const status = range ? 206 : 200
      if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers })
      return new Response(this.body(record, first.bytes, start + first.length, end), {
        status,
        headers,
      })
    }
    return answer(502)
  }

  /** The whole file, when it is at most `max` bytes. */
  async readAll(record: HostMediaRecord, max: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let offset = 0
    let size = record.size
    do {
      if (size > max) throw new Error('The file is too large to copy from its host')
      const part = await this.part(record, offset, PART_BYTES)
      if (part.kind !== 'granted') throw new Error('The file is no longer available on its host')
      size = part.media.size
      parts.push(new Uint8Array(part.bytes))
      offset += part.length
      if (part.length === 0) break
    } while (offset < size)
    const out = new Uint8Array(offset)
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }

  /** Writes the file to `to`, part by part; nothing is left there when it fails. */
  async saveTo(record: HostMediaRecord, to: string): Promise<void> {
    const file = await open(to, 'w')
    try {
      let offset = 0
      let size = record.size
      do {
        const part = await this.part(record, offset, PART_BYTES)
        if (part.kind !== 'granted') throw new Error('The file is no longer available on its host')
        size = part.media.size
        if (part.length === 0) break
        await file.write(new Uint8Array(part.bytes))
        offset += part.length
      } while (offset < size)
      await file.close()
    } catch (error) {
      await file.close().catch(() => {})
      await rm(to, { force: true })
      throw error
    }
  }

  /** The rest of a range after its first part, read one part at a time as the reader takes it. */
  private body(
    record: HostMediaRecord,
    first: ArrayBuffer,
    from: number,
    end: number,
  ): ReadableStream<Uint8Array> {
    let next = from
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array(first))
        if (next > end) controller.close()
      },
      pull: async (controller) => {
        const part = await this.part(record, next, Math.min(PART_BYTES, end - next + 1))
        if (part.kind !== 'granted' || part.length === 0) {
          throw new Error('The file changed on its host')
        }
        controller.enqueue(new Uint8Array(part.bytes))
        next += part.length
        if (next > end) controller.close()
      },
    })
  }

  private async part(record: HostMediaRecord, offset: number, length: number): Promise<Part> {
    const { hostId, projectPath, path, sessionId } = record
    const read: MediaReadParams = {
      projectPath,
      path,
      ...(sessionId === null ? {} : { sessionId }),
      offset,
      length,
    }
    const part = (await this.read(hostId, read)) as Part | null
    if (part?.kind !== 'granted') {
      return {
        kind: part?.kind === 'forbidden' || part?.kind === 'not_media' ? part.kind : 'not_found',
      }
    }
    if (!(part.bytes instanceof ArrayBuffer) || part.bytes.byteLength !== part.length) {
      throw new Error('The host sent a part that is not the one asked for')
    }
    return part
  }
}
