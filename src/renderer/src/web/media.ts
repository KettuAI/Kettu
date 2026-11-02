// Media in the web client. Where a window asks main's media scheme for a grant, the page asks the
// host what the file is with an empty `media.read` and shows it from a URL of its own. Where the
// browser gives the page a service worker, the worker answers that URL with the ranges a player
// asks for, each part read here over the channel. Elsewhere, as over plain http, the page reads a
// file whole into a blob, and offers a larger one than it can hold for saving instead.

import type { DeviceFileContent, FileContent } from '@shared/files'
import type { MediaGrant, MediaOpenResult } from '@shared/media'
import type { MediaReadParams, MediaReadResult } from '@shared/remote/streams'
import type { HostLink } from './link'
import { MEDIA_PATH, mediaToken, PART_BYTES, type Part, type PartAsk } from './media-ranges'

/** Blob URLs kept alive; older ones are revoked, and a view that still shows one asks again. */
const MAX_URLS = 100

/** Files the page answers its media URLs for; the oldest are forgotten. */
const MAX_FILES = 1_000

/** Larger media is not read into the page, which would hold it all; nor is a larger picture shown. */
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024

/** How long the worker has to take the page before media is read whole instead. */
const WORKER_WAIT_MS = 3_000

/** How long a save's frame stays; the download goes on without it once it has begun. */
const SAVE_FRAME_MS = 60_000

const urls: string[] = []

type ReadResult =
  | (Omit<Extract<MediaReadResult, { kind: 'granted' }>, 'bytes'> & { bytes: ArrayBuffer })
  | Exclude<MediaReadResult, { kind: 'granted' }>

/** A file a media URL of the page names: where it is on the host, and what it was when granted. */
interface Known {
  params: MediaReadParams
  name: string
  mimeType: string
  size: number
}

const files = new Map<string, Known>()
let worker: Promise<boolean> = Promise.resolve(false)

function keep(url: string): void {
  urls.push(url)
  while (urls.length > MAX_URLS) URL.revokeObjectURL(urls.shift()!)
}

function remember(known: Known): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
  files.set(token, known)
  for (const old of files.keys()) {
    if (files.size <= MAX_FILES) break
    files.delete(old)
  }
  return token
}

/** The file one of the page's media URLs names, or null for any other URL. */
function knownOf(url: string): Known | null {
  const parsed = URL.parse(url, location.href)
  if (parsed?.origin !== location.origin) return null
  const token = mediaToken(parsed.pathname)
  return token ? (files.get(token) ?? null) : null
}

/** A part of a file the page knows, read from the host; `signal` cancels it there. */
async function readPart(
  link: HostLink,
  known: Known,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Part> {
  if (length === 0) {
    const { name, mimeType, size } = known
    return { kind: 'granted', name, mimeType, size, offset, length: 0, bytes: new ArrayBuffer(0) }
  }
  try {
    const read = (await link.request(
      'media.read',
      { ...known.params, offset, length },
      signal,
    )) as ReadResult
    if (read.kind !== 'granted') return { kind: read.kind === 'not_found' ? 'not_found' : 'failed' }
    if (read.bytes.byteLength !== read.length) return { kind: 'failed' }
    known.size = read.media.size
    return {
      kind: 'granted',
      name: known.name,
      mimeType: known.mimeType,
      size: read.media.size,
      offset: read.offset,
      length: read.length,
      bytes: read.bytes,
    }
  } catch {
    return { kind: signal?.aborted ? 'cancelled' : 'failed' }
  }
}

/**
 * Starts the media worker where the browser has service workers, and answers its parts. Media
 * waits for it at most a moment, then is read whole as where there is none.
 */
export function startMediaWorker(link: HostLink, script: string): void {
  const container = window.isSecureContext ? navigator.serviceWorker : undefined
  if (!container) return
  container.addEventListener('message', (event: MessageEvent) => {
    const ask = event.data as Partial<PartAsk> | null
    const port = event.ports[0]
    if (ask?.type !== 'kettu-media' || !port || typeof ask.token !== 'string') return
    const known = files.get(ask.token)
    const { offset, length } = ask
    if (!known || !isCount(offset) || !isCount(length)) {
      port.postMessage({ kind: 'not_found' } satisfies Part)
      return
    }
    const cancel = new AbortController()
    port.onmessage = () => cancel.abort()
    void readPart(link, known, offset, length, cancel.signal).then((part) => {
      if (part.kind === 'cancelled') return
      port.postMessage(part, part.kind === 'granted' ? [part.bytes] : [])
      port.close()
    })
  })
  container.startMessages()
  worker = (async () => {
    try {
      await container.register(script, { scope: '/' })
    } catch (error) {
      console.warn('Media is read whole: the media worker did not start', error)
      return false
    }
    if (container.controller) return true
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), WORKER_WAIT_MS)
      container.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer)
          resolve(true)
        },
        { once: true },
      )
    })
  })()
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A grant as a window's would be, for a file on the host. */
async function grant(link: HostLink, params: MediaReadParams): Promise<MediaOpenResult> {
  const about = (await link.request('media.read', { ...params, length: 0 })) as ReadResult
  if (about.kind !== 'granted') return about
  const { media } = about
  const token = remember({ params, name: media.name, mimeType: media.mimeType, size: media.size })
  const shown: MediaGrant = {
    url: `${MEDIA_PATH}${token}/${encodeURIComponent(media.name)}`,
    kind: media.kind,
    mimeType: media.mimeType,
    size: media.size,
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
  }
  const streamed = await worker
  // The worker plays any clip by ranges; a picture still decodes whole.
  const tooLarge = media.size > MAX_MEDIA_BYTES && (!streamed || media.kind === 'image')
  if (tooLarge) return { kind: 'granted', grant: { ...shown, tooLarge: true } }
  if (streamed) return { kind: 'granted', grant: shown }
  const read = (await link.request('media.read', params)) as ReadResult
  if (read.kind !== 'granted') return read
  if (read.media.size > MAX_MEDIA_BYTES) {
    return { kind: 'granted', grant: { ...shown, size: read.media.size, tooLarge: true } }
  }
  const url = URL.createObjectURL(new Blob([read.bytes], { type: read.media.mimeType }))
  keep(url)
  return { kind: 'granted', grant: { ...shown, url, size: read.media.size } }
}

/**
 * The requests a window answers with main's media scheme, answered over the channel instead; null
 * for every other request, which goes to the host as it is.
 */
export function mediaRequest(
  link: HostLink,
  method: string,
  params: unknown,
): Promise<unknown> | null {
  if (method === 'media.open') return grant(link, params as MediaReadParams)
  if (method !== 'files.read') return null
  const { projectPath } = params as { projectPath: string }
  return link.request(method, params).then(async (result) => {
    const content = result as DeviceFileContent
    if (content.kind !== 'media') return content
    const opened = await grant(link, { projectPath, path: content.path })
    if (opened.kind !== 'granted') {
      return { kind: 'binary', path: content.path, size: content.media.size } satisfies FileContent
    }
    return { kind: 'media', path: content.path, grant: opened.grant } satisfies FileContent
  })
}

/** Hands the browser a file to save. */
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** What saving a file the page reads itself shows while it goes. */
export interface SaveProgress {
  /** `done` of `size` bytes so far. */
  update(done: number, size: number): void
  close(): void
}

/**
 * Saves a file one of the page's media URLs names: through the worker straight to the browser's
 * downloads, or read here part by part, with its progress, into a file to save. False once the
 * save is cancelled, which `progress` is given the means to do; null for any other URL.
 */
export async function saveMedia(
  link: HostLink,
  url: string,
  progress: (name: string, cancel: () => void) => Promise<SaveProgress>,
): Promise<boolean | null> {
  const known = knownOf(url)
  if (!known) return null
  if (await worker) {
    // A link's download skips the worker; a frame's navigation reaches it, and the answer's
    // Content-Disposition hands it to the downloads.
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.src = `${url}${url.includes('?') ? '&' : '?'}save`
    document.body.append(frame)
    setTimeout(() => frame.remove(), SAVE_FRAME_MS)
    return true
  }
  const cancel = new AbortController()
  const shown = await progress(known.name, () => cancel.abort())
  try {
    const parts: Blob[] = []
    let offset = 0
    let size = known.size
    shown.update(0, size)
    while (offset < size) {
      const part = await readPart(link, known, offset, PART_BYTES, cancel.signal)
      if (part.kind === 'cancelled') return false
      if (part.kind !== 'granted') throw new Error('The file is no longer available on its host')
      if (part.length === 0) break
      size = part.size
      // A blob of each part lets the browser keep what came out of the page's memory.
      parts.push(new Blob([part.bytes]))
      offset += part.length
      shown.update(offset, size)
    }
    downloadFile(new Blob(parts, { type: known.mimeType }), known.name)
    return true
  } finally {
    shown.close()
  }
}
