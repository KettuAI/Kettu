import { describe, expect, it } from 'vitest'
import {
  MAX_RESPONSE_BYTES,
  mediaToken,
  PART_BYTES,
  respondMedia,
  type AskPart,
  type Part,
} from './media-ranges'

/** A page that answers parts of `file`, keeping what it was asked and the signals it got. */
function page(file: Uint8Array, options: { size?: () => number; hold?: boolean } = {}) {
  const asked: { offset: number; length: number }[] = []
  const signals: AbortSignal[] = []
  const ask: AskPart = async (offset, length, signal) => {
    asked.push({ offset, length })
    if (signal) signals.push(signal)
    // A part after the first waits until it is given up, as a slow host's would.
    if (options.hold && offset > 0 && length > 0) {
      return new Promise<Part>((resolve) =>
        signal?.addEventListener('abort', () => resolve({ kind: 'cancelled' })),
      )
    }
    const bytes = file.slice(offset, offset + length)
    return {
      kind: 'granted',
      name: 'clip café.mp4',
      mimeType: 'video/mp4',
      size: options.size?.() ?? file.length,
      offset,
      length: bytes.length,
      bytes: bytes.buffer,
    }
  }
  return { ask, asked, signals }
}

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = i % 251
  return out
}

/** Whether two byte arrays hold the same bytes, faster than a deep equal of a megabyte. */
function same(a: ArrayBuffer, b: Uint8Array): boolean {
  const bytes = new Uint8Array(a)
  return bytes.length === b.length && bytes.every((byte, i) => byte === b[i])
}
const get = (range?: string, method = 'GET') =>
  new Request('http://host.test/media/abcdefghijklmnopqrstuvwx/clip.mp4', {
    method,
    headers: range ? { range } : {},
  })

describe('mediaToken', () => {
  it('reads the token of a media URL and nothing else', () => {
    expect(mediaToken('/media/abcdefghijklmnopqrstuvwx/clip.mp4')).toBe('abcdefghijklmnopqrstuvwx')
    expect(mediaToken('/media/short/clip.mp4')).toBeNull()
    expect(mediaToken('/assets/abcdefghijklmnopqrstuvwx/clip.mp4')).toBeNull()
    expect(mediaToken('/media/abcdefghijklmnop..rstuvwx/clip.mp4')).toBeNull()
  })
})

describe('respondMedia', () => {
  it('answers the whole file, part by part, with its type and length', async () => {
    const file = bytes(PART_BYTES * 2 + 10)
    const t = page(file)
    const { response, done } = await respondMedia(get(), t.ask, false)
    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
      'content-length': String(file.length),
    })
    expect(same(await response.arrayBuffer(), file)).toBe(true)
    await done
    expect(t.asked).toEqual([
      { offset: 0, length: 0 },
      { offset: 0, length: PART_BYTES },
      { offset: PART_BYTES, length: PART_BYTES },
      { offset: PART_BYTES * 2, length: 10 },
    ])
  })

  it('answers a range with 206, and an open one up to its most', async () => {
    const file = bytes(5000)
    const t = page(file)
    const { response } = await respondMedia(get('bytes=100-199'), t.ask, false)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 100-199/5000')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.slice(100, 200))

    const big = page(bytes(16), { size: () => MAX_RESPONSE_BYTES * 4 })
    const open = await respondMedia(get('bytes=0-'), big.ask, false)
    expect(open.response.headers.get('content-range')).toBe(
      `bytes 0-${MAX_RESPONSE_BYTES - 1}/${MAX_RESPONSE_BYTES * 4}`,
    )
    expect(open.response.headers.get('content-length')).toBe(String(MAX_RESPONSE_BYTES))
    await open.response.body?.cancel()
  })

  it('stops reading once the player drops the response, cancelling the part on its way', async () => {
    const t = page(bytes(PART_BYTES * 3), { hold: true })
    const { response, done } = await respondMedia(get('bytes=0-'), t.ask, false)
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toHaveLength(PART_BYTES)
    // The stream reads the next part ahead, which now waits.
    await expect.poll(() => t.signals.length).toBe(1)
    await reader.cancel()
    await done
    expect(t.signals[0]!.aborted).toBe(true)
    expect(t.asked.at(-1)).toEqual({ offset: PART_BYTES, length: PART_BYTES })
  })

  it('answers HEAD and a file of nothing without reading, and a range past the end with 416', async () => {
    const t = page(bytes(300))
    const head = await respondMedia(get('bytes=0-99', 'HEAD'), t.ask, false)
    expect(head.response.status).toBe(206)
    expect(head.response.headers.get('content-length')).toBe('100')
    expect(t.asked).toEqual([{ offset: 0, length: 0 }])
    const past = await respondMedia(get('bytes=300-'), t.ask, false)
    expect(past.response.status).toBe(416)
    expect(past.response.headers.get('content-range')).toBe('bytes */300')
    const empty = await respondMedia(get(), page(bytes(0)).ask, false)
    expect(empty.response.status).toBe(200)
    expect((await empty.response.arrayBuffer()).byteLength).toBe(0)
  })

  it('hands a save to the downloads under the file’s name', async () => {
    const { response } = await respondMedia(get(), page(bytes(10)).ask, true)
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="clip caf_.mp4"; filename*=UTF-8''clip%20caf%C3%A9.mp4`,
    )
  })

  it('reads a file that changed size by its new size, and says when it is gone', async () => {
    let size = 100
    const file = bytes(200)
    const t = page(file, { size: () => size })
    // The page knew it at 100 bytes; the host has 200 by the first part.
    const ask: AskPart = async (offset, length, signal) => {
      if (length > 0) size = 200
      return t.ask(offset, length, signal)
    }
    const { response } = await respondMedia(get(), ask, false)
    expect(response.headers.get('content-length')).toBe('200')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(file)

    const gone: AskPart = async () => ({ kind: 'not_found' })
    expect((await respondMedia(get(), gone, false)).response.status).toBe(404)
    const failed: AskPart = async (_offset, length) =>
      length === 0 ? page(bytes(10)).ask(0, 0) : { kind: 'failed' }
    expect((await respondMedia(get(), failed, false)).response.status).toBe(502)
  })
})
