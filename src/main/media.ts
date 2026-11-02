// The media scheme: files the agent host granted, served to the app's own page alone.

import { open, realpath } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { CustomScheme, Session, WebFrameMain } from 'electron'
import {
  MEDIA_SCHEME,
  MEDIA_TOKEN,
  mediaUrlToken,
  parseRange,
  type MediaGrantRecord,
} from '@shared/media'
import type { HostMedia } from './host-media'
import { refuseRequests } from './request-filter'

/**
 * `stream` too, since audio and video expect a streamed response, and `corsEnabled`, so the app's
 * page can draw a picture on a canvas to copy it.
 */
export const mediaScheme: CustomScheme = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, stream: true, corsEnabled: true },
}

const MAX_GRANTS = 2_000
/**
 * How long a request for an unknown token waits for its grant: the host hands main the grant and
 * the renderer its URL over different channels, so the URL can arrive first.
 */
export const GRANT_WAIT_MS = 1_000

/** The grants the host issued this run, oldest first. */
export class MediaGrants {
  private readonly byToken = new Map<string, MediaGrantRecord>()
  private readonly waiting = new Map<string, Set<(grant: MediaGrantRecord) => void>>()

  constructor(private readonly waitMs = GRANT_WAIT_MS) {}

  add(grant: MediaGrantRecord): void {
    this.byToken.delete(grant.token)
    this.byToken.set(grant.token, grant)
    for (const token of this.byToken.keys()) {
      if (this.byToken.size <= MAX_GRANTS) break
      this.byToken.delete(token)
    }
    const waiters = this.waiting.get(grant.token)
    this.waiting.delete(grant.token)
    for (const resolve of waiters ?? []) resolve(grant)
  }

  /** Drops a session's grants, or every grant for null. */
  revoke(sessionId: string | null): void {
    if (sessionId === null) {
      this.byToken.clear()
      return
    }
    for (const [token, grant] of this.byToken) {
      if (grant.sessionId === sessionId) this.byToken.delete(token)
    }
  }

  find(token: string): Promise<MediaGrantRecord | null> {
    const grant = this.byToken.get(token)
    if (grant) return Promise.resolve(grant)
    return new Promise((resolve) => {
      const waiters = this.waiting.get(token) ?? new Set()
      this.waiting.set(token, waiters)
      const settle = (found: MediaGrantRecord | null) => {
        clearTimeout(timer)
        waiters.delete(settle)
        if (waiters.size === 0 && this.waiting.get(token) === waiters) this.waiting.delete(token)
        resolve(found)
      }
      const timer = setTimeout(() => settle(null), this.waitMs)
      waiters.add(settle)
    })
  }
}

const HEADERS = {
  'Accept-Ranges': 'bytes',
  // Safe for any origin: the request filter, not CORS, decides who may read, the app's page alone.
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  // Should a response ever open as a document, it runs nothing.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}

function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...HEADERS, ...headers } })
}

/** Answers one request on the media scheme, for a file here or on another host. */
export async function respondMedia(
  request: Request,
  grants: MediaGrants,
  hostMedia?: HostMedia,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405)
  const token = URL.parse(request.url)?.hostname ?? ''
  if (!MEDIA_TOKEN.test(token)) return answer(404)
  const onHost = hostMedia?.find(token)
  if (onHost) return hostMedia!.respond(request, onHost)
  const grant = await grants.find(token)
  if (!grant) return answer(404)
  try {
    // A file swapped for a link since the grant leads somewhere no one granted.
    if ((await realpath(grant.path)) !== grant.path) return answer(404)
    const file = await open(grant.path, 'r')
    // The stream closes the file once it is handed one.
    let streamed = false
    try {
      const info = await file.stat()
      if (!info.isFile()) return answer(404)
      const range = parseRange(request.headers.get('range'), info.size)
      if (range === 'unsatisfiable') {
        return answer(416, { 'Content-Range': `bytes */${info.size}` })
      }
      // Within the size just read, so a file still being written cannot outrun its length.
      const { start, end } = range ?? { start: 0, end: info.size - 1 }
      const status = range ? 206 : 200
      const headers: Record<string, string> = {
        ...HEADERS,
        'Content-Type': grant.mimeType,
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
      }
      if (request.method === 'HEAD' || info.size === 0) {
        return new Response(null, { status, headers })
      }
      const stream = file.createReadStream({ start, end })
      streamed = true
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status,
        headers,
      })
    } finally {
      if (!streamed) await file.close()
    }
  } catch {
    return answer(404)
  }
}

/**
 * The grant behind a media URL main still holds, for the actions on a file: never a path from
 * the renderer. Throws when the grant is gone or the file was swapped for a link.
 */
export async function grantedFile(url: unknown, grants: MediaGrants): Promise<MediaGrantRecord> {
  const token = typeof url === 'string' ? mediaUrlToken(url) : null
  const grant = token ? await grants.find(token) : null
  if (!grant) throw new Error('The file is no longer available here')
  if ((await realpath(grant.path)) !== grant.path) throw new Error('The file has moved')
  return grant
}

/** The real path behind a media URL main still grants; see `grantedFile`. */
export async function grantedPath(url: unknown, grants: MediaGrants): Promise<string> {
  return (await grantedFile(url, grants)).path
}

/** Whether a request on the media scheme may go: only the app's own page, its main frame. */
export function mayRequestMedia(
  frame: WebFrameMain | null | undefined,
  isRendererUrl: (url: string | undefined) => boolean,
): boolean {
  try {
    return !!frame && frame.parent === null && isRendererUrl(frame.url)
  } catch {
    // A frame whose document went away.
    return false
  }
}

/** Serves the media scheme on the session, and refuses it to anything but the app's page. */
export function serveMedia(
  session: Session,
  grants: MediaGrants,
  isRendererUrl: (url: string | undefined) => boolean,
  hostMedia?: HostMedia,
): void {
  session.protocol.handle(MEDIA_SCHEME, (request) => respondMedia(request, grants, hostMedia))
  refuseRequests(
    session,
    (details) =>
      details.url.startsWith(`${MEDIA_SCHEME}:`) && !mayRequestMedia(details.frame, isRendererUrl),
  )
}
