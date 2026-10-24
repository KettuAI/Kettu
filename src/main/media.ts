// The media scheme: files the agent host granted, served to the app's own page alone. See
// docs/design/media.md#serving.

import { open, realpath } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { CustomScheme, Session, WebFrameMain } from 'electron'
import { MEDIA_SCHEME, MEDIA_TOKEN, type MediaGrantRecord } from '@shared/media'
import { refuseRequests } from './request-filter'

/** `stream` too, which audio and video will need, since they expect a streamed response. */
export const mediaScheme: CustomScheme = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, stream: true },
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
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  // Should a response ever open as a document, it runs nothing.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}

function answer(status: number): Response {
  return new Response(null, { status, headers: HEADERS })
}

/** Answers one request on the media scheme. */
export async function respondMedia(request: Request, grants: MediaGrants): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405)
  const token = URL.parse(request.url)?.hostname ?? ''
  if (!MEDIA_TOKEN.test(token)) return answer(404)
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
      const headers = {
        ...HEADERS,
        'Content-Type': grant.mimeType,
        'Content-Length': String(info.size),
      }
      if (request.method === 'HEAD' || info.size === 0) return new Response(null, { headers })
      // Exactly the size just read, so a file still being written cannot outrun its length.
      const stream = file.createReadStream({ start: 0, end: info.size - 1 })
      streamed = true
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers })
    } finally {
      if (!streamed) await file.close()
    }
  } catch {
    return answer(404)
  }
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
): void {
  session.protocol.handle(MEDIA_SCHEME, (request) => respondMedia(request, grants))
  refuseRequests(
    session,
    (details) =>
      details.url.startsWith(`${MEDIA_SCHEME}:`) && !mayRequestMedia(details.frame, isRendererUrl),
  )
}
