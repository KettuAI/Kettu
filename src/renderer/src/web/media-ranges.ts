// How the web client's media worker answers a media URL: the range a player asks for, read from
// the page one part at a time, each part a `media.read` of its own over the channel, so a video of
// any size starts and seeks at once and a response the player drops stops reading.

import { parseRange } from '@shared/media'

/** Where the page's media URLs live: `/media/<token>/<file name>`, `?save` to download it. */
export const MEDIA_PATH = '/media/'

/** The most one part asks of the host, as the desktop app reads another host's media. */
export const PART_BYTES = 1024 * 1024

/**
 * The most one response to a range carries. A player asks again past it, so no response stays
 * open long enough for the browser to stop the worker under it.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** What the worker asks the page: `length` bytes of the file from `offset`; 0 asks what it is. */
export interface PartAsk {
  type: 'kettu-media'
  token: string
  offset: number
  length: number
}

/** The page's answer: the bytes and what the file is now, or why there are none. */
export type Part =
  | {
      kind: 'granted'
      name: string
      mimeType: string
      size: number
      offset: number
      length: number
      bytes: ArrayBuffer
    }
  | { kind: 'not_found' | 'failed' | 'cancelled' }

/** Asks the page for a part; `signal` gives it up, and the page cancels it on the host. */
export type AskPart = (offset: number, length: number, signal?: AbortSignal) => Promise<Part>

const HEADERS = {
  'Accept-Ranges': 'bytes',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
}

/** The token a media URL's path names, or null when it is none. */
export function mediaToken(pathname: string): string | null {
  if (!pathname.startsWith(MEDIA_PATH)) return null
  const token = pathname.slice(MEDIA_PATH.length).split('/')[0] ?? ''
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: code, headers: { ...HEADERS, ...headers } })
}

/** `attachment` with the name in both forms, for a browser of any age. */
function attachment(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Answers a GET or HEAD on a media URL: the whole file, or the one range its `Range` asks for, at
 * most `MAX_RESPONSE_BYTES` of it; `save` hands it to the browser's downloads. `done` settles once
 * the body is read to its end or given up, for the worker to stay up until then.
 */
export async function respondMedia(
  request: Request,
  ask: AskPart,
  save: boolean,
): Promise<{ response: Response; done: Promise<void> }> {
  const answered = (response: Response) => ({ response, done: Promise.resolve() })
  if (request.method !== 'GET' && request.method !== 'HEAD') return answered(status(405))
  const header = request.headers.get('range')
  const about = await ask(0, 0)
  if (about.kind !== 'granted') return answered(status(about.kind === 'not_found' ? 404 : 502))
  let size = about.size
  // The first part says how large the file is now; a file that changed is read again by it.
  for (let tries = 0; tries < 2; tries++) {
    const range = header === null ? null : parseRange(header, size)
    if (range === 'unsatisfiable') {
      return answered(status(416, { 'Content-Range': `bytes */${size}` }))
    }
    const start = range?.start ?? 0
    const end = range ? Math.min(range.end, start + MAX_RESPONSE_BYTES - 1) : size - 1
    const headers: Record<string, string> = {
      ...HEADERS,
      'Content-Type': about.mimeType,
      'Content-Length': String(Math.max(0, end - start + 1)),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      ...(save ? { 'Content-Disposition': attachment(about.name) } : {}),
    }
    const code = range ? 206 : 200
    if (request.method === 'HEAD' || size === 0) {
      return answered(new Response(null, { status: code, headers }))
    }
    const first = await ask(start, Math.min(PART_BYTES, end - start + 1))
    if (first.kind !== 'granted') return answered(status(first.kind === 'not_found' ? 404 : 502))
    if (first.size !== size) {
      size = first.size
      continue
    }
    const { body, done } = rest(ask, first.bytes, start + first.length, end)
    return { response: new Response(body, { status: code, headers }), done }
  }
  return answered(status(502))
}

/** The range after its first part, a part at a time as the player reads it. */
function rest(
  ask: AskPart,
  first: ArrayBuffer,
  from: number,
  end: number,
): { body: ReadableStream<Uint8Array>; done: Promise<void> } {
  let next = from
  let reading: AbortController | null = null
  let finish = () => {}
  const done = new Promise<void>((resolve) => (finish = resolve))
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new Uint8Array(first))
      if (next > end) {
        controller.close()
        finish()
      }
    },
    pull: async (controller) => {
      reading = new AbortController()
      const part = await ask(next, Math.min(PART_BYTES, end - next + 1), reading.signal)
      reading = null
      if (part.kind === 'cancelled') return
      if (part.kind !== 'granted' || part.length === 0) {
        finish()
        controller.error(new Error('The file changed on its host'))
        return
      }
      controller.enqueue(new Uint8Array(part.bytes))
      next += part.length
      if (next > end) {
        controller.close()
        finish()
      }
    },
    cancel: () => {
      reading?.abort()
      finish()
    },
  })
  return { body, done }
}
