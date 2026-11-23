// Reads a file on a media URL: the media scheme, the web client's own path or its `blob:` URLs.
// An XHR, since the desktop page's policy lets it request the scheme but not fetch it, and the
// page's policy lets no request read a `blob:` URL, whose bytes come from the held blob.

import { blobOf } from './media-blobs'

/**
 * Reads `begin` to `end` (exclusive) of a file on the media scheme, and how long the file is.
 * PDF.js reads ranges from http(s) URLs alone, so it reads these through `RangeTransport`.
 */
export function readRange(
  url: string,
  begin: number,
  end: number,
  requests: Set<XMLHttpRequest>,
): Promise<{ bytes: Uint8Array; total: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    requests.add(request)
    request.open('GET', url)
    request.responseType = 'arraybuffer'
    request.setRequestHeader('Range', `bytes=${begin}-${end - 1}`)
    request.onload = () => {
      requests.delete(request)
      const body = request.response as ArrayBuffer
      if (request.status === 206) {
        const total = Number(/\/(\d+)$/.exec(request.getResponseHeader('Content-Range') ?? '')?.[1])
        if (Number.isSafeInteger(total)) return resolve({ bytes: new Uint8Array(body), total })
      } else if (request.status === 200) {
        // A server that ignored the range sent the whole file.
        const whole = new Uint8Array(body)
        return resolve({ bytes: whole.subarray(begin, end), total: whole.length })
      }
      reject(new Error(`The file could not be read: ${request.status}`))
    }
    request.onerror = () => {
      requests.delete(request)
      reject(new Error('The file could not be read'))
    }
    request.onabort = () => requests.delete(request)
    request.send()
  })
}

/** The whole file at a media URL; `signal` abandons the read. */
export async function readMedia(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (url.startsWith('blob:')) {
    const blob = blobOf(url)
    if (!blob) throw new Error('The file is no longer held')
    return new Uint8Array(await blob.arrayBuffer())
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const settle = () => signal?.removeEventListener('abort', abort)
    request.open('GET', url)
    request.responseType = 'arraybuffer'
    request.onload = () => {
      settle()
      if (request.status === 200) resolve(new Uint8Array(request.response as ArrayBuffer))
      else reject(new Error(`The file could not be read: ${request.status}`))
    }
    request.onerror = () => {
      settle()
      reject(new Error('The file could not be read'))
    }
    request.onabort = () => {
      settle()
      reject(new DOMException('The read was abandoned', 'AbortError'))
    }
    if (signal?.aborted) return abort()
    request.send()
  })
}
