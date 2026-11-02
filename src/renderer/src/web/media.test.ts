// The web client's media over a fake link: what a grant reads first, when a file is too large to
// show, the parts the media worker asks for and their cancelling, and saving without the worker.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaReadParams } from '@shared/remote/streams'
import type { HostLink } from './link'
import type { Part } from './media-ranges'

const MB = 1024 * 1024

interface Asked {
  method: string
  params: MediaReadParams
  signal: AbortSignal | undefined
}

/** A link to a host holding one file of `size` bytes, which answers parts of it. */
function fakeLink(size: number, kind: 'video' | 'image' = 'video', hold = false) {
  const asked: Asked[] = []
  const link = {
    request: async (method: string, params: MediaReadParams, signal?: AbortSignal) => {
      asked.push({ method, params, signal })
      const offset = params.offset ?? 0
      const length = Math.min(params.length ?? size - offset, size - offset)
      if (hold && length > 0) {
        await new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
        )
      }
      return {
        kind: 'granted',
        media: { name: 'clip.mp4', kind, mimeType: 'video/mp4', size },
        offset,
        length,
        bytes: new ArrayBuffer(length),
      }
    },
  }
  return { link: link as unknown as HostLink, asked }
}

const container = {
  controller: {} as object | null,
  listeners: [] as ((event: MessageEvent) => void)[],
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(listener)
  },
  startMessages() {},
  register: vi.fn(async () => {}),
}

async function load(secure: boolean) {
  vi.resetModules()
  vi.stubGlobal('window', { isSecureContext: secure })
  vi.stubGlobal('navigator', { serviceWorker: container })
  vi.stubGlobal('location', { href: 'http://host.test/', origin: 'http://host.test' })
  return import('./media')
}

const params = { projectPath: '/work', path: 'clip.mp4', sessionId: 's1' }

beforeEach(() => {
  container.listeners = []
  container.controller = {}
  container.register.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('media without the worker', () => {
  it('asks what a file is, then reads one it can hold whole', async () => {
    const { mediaRequest } = await load(false)
    const { link, asked } = fakeLink(1000)
    const opened = (await mediaRequest(link, 'media.open', params)) as {
      grant: { url: string; size: number; tooLarge?: boolean }
    }
    expect(asked.map((each) => each.params)).toEqual([{ ...params, length: 0 }, params])
    expect(opened.grant.url).toMatch(/^blob:/)
    expect(opened.grant).toMatchObject({ size: 1000 })
    expect(opened.grant.tooLarge).toBeUndefined()
  })

  it('offers a larger file for saving without reading it, then saves it part by part', async () => {
    const { mediaRequest, saveMedia } = await load(false)
    const { link, asked } = fakeLink(129 * MB)
    const opened = (await mediaRequest(link, 'media.open', params)) as {
      grant: { url: string; tooLarge?: boolean }
    }
    expect(opened.grant).toMatchObject({ tooLarge: true })
    expect(opened.grant.url).toMatch(/^\/media\/[\w-]+\/clip\.mp4$/)
    expect(asked).toHaveLength(1)

    const clicked: string[] = []
    vi.stubGlobal('document', {
      createElement: () => ({ click: () => clicked.push('saved'), remove() {} }),
      body: { append() {} },
    })
    const progress: number[] = []
    const shown = { update: (done: number) => progress.push(done), close: vi.fn() }
    expect(await saveMedia(link, opened.grant.url, async () => shown)).toBe(true)
    expect(asked).toHaveLength(1 + 129)
    expect(asked.at(-1)!.params).toMatchObject({ offset: 128 * MB, length: MB })
    expect(progress.at(-1)).toBe(129 * MB)
    expect(clicked).toEqual(['saved'])
    expect(shown.close).toHaveBeenCalled()
    expect(await saveMedia(link, 'blob:http://host.test/other', async () => shown)).toBeNull()
  })

  it('gives up a save once cancelled, cancelling the part on its way', async () => {
    const { mediaRequest, saveMedia } = await load(false)
    const { link, asked } = fakeLink(200 * MB, 'video', true)
    const opened = (await mediaRequest(link, 'media.open', params)) as { grant: { url: string } }
    let cancel = () => {}
    const saving = saveMedia(link, opened.grant.url, async (_name, cancelIt) => {
      cancel = cancelIt
      return { update() {}, close() {} }
    })
    await expect.poll(() => asked.length).toBe(2)
    cancel()
    expect(await saving).toBe(false)
    expect(asked[1]!.signal?.aborted).toBe(true)
  })
})

describe('media with the worker', () => {
  it('plays a clip of any size from its URL, but offers a large picture for saving', async () => {
    const { mediaRequest, startMediaWorker } = await load(true)
    const big = fakeLink(4096 * MB)
    startMediaWorker(big.link, '/assets/media-worker-x.js')
    expect(container.register).toHaveBeenCalledWith('/assets/media-worker-x.js', { scope: '/' })
    const clip = (await mediaRequest(big.link, 'media.open', params)) as {
      grant: { url: string; tooLarge?: boolean }
    }
    expect(clip.grant.url).toMatch(/^\/media\//)
    expect(clip.grant.tooLarge).toBeUndefined()
    expect(big.asked).toHaveLength(1)
    const picture = fakeLink(200 * MB, 'image')
    const opened = (await mediaRequest(picture.link, 'media.open', params)) as {
      grant: { tooLarge?: boolean }
    }
    expect(opened.grant.tooLarge).toBe(true)
  })

  it('answers the worker’s parts of a file it granted, and cancels one the worker gives up', async () => {
    const { mediaRequest, startMediaWorker } = await load(true)
    const { link, asked } = fakeLink(10 * MB, 'video', true)
    startMediaWorker(link, '/assets/media-worker-x.js')
    const opened = (await mediaRequest(link, 'media.open', params)) as { grant: { url: string } }
    const token = opened.grant.url.split('/')[2]!
    const ask = (part: object) => {
      const { port1, port2 } = new MessageChannel()
      const answer = new Promise<Part>((resolve) => {
        port1.onmessage = (message) => resolve(message.data as Part)
      })
      for (const listener of container.listeners) {
        listener({ data: { type: 'kettu-media', ...part }, ports: [port2] } as never)
      }
      return { answer, port: port1 }
    }
    expect(await ask({ token, offset: 0, length: 0 }).answer).toMatchObject({
      kind: 'granted',
      size: 10 * MB,
      length: 0,
    })
    expect(await ask({ token: 'unknown-token-000000', offset: 0, length: 0 }).answer).toEqual({
      kind: 'not_found',
    })
    const reading = ask({ token, offset: MB, length: MB })
    await expect.poll(() => asked.length).toBe(2)
    expect(asked[1]!.params).toMatchObject({ ...params, offset: MB, length: MB })
    reading.port.postMessage('cancel')
    await expect.poll(() => asked[1]!.signal?.aborted).toBe(true)
    reading.port.close()
  })
})
