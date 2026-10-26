import { mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import type {
  CallbackResponse,
  OnBeforeRequestListenerDetails,
  Session,
  WebFrameMain,
} from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaGrantRecord } from '@shared/media'
import {
  grantedPath,
  MediaGrants,
  mayRequestMedia,
  mediaScheme,
  parseRange,
  respondMedia,
  serveMedia,
} from './media'

const open = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  open.mockImplementation(actual.open)
  return { ...actual, open }
})

const posixOnly = process.platform === 'win32' ? it.skip : it

const token = (n: number) => String.fromCharCode(97 + n).repeat(26)

function grant(n: number, path: string, sessionId: string | null = 's1'): MediaGrantRecord {
  return { token: token(n), path, mimeType: 'image/png', sessionId }
}

const APP = 'http://localhost:5173/'
const isRenderer = (url: string | undefined) => url === APP
const frame = (url: string, parent: unknown = null) => ({ url, parent }) as WebFrameMain

const HARDENING = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
}

describe('mediaScheme', () => {
  it('asks for CORS beside its other privileges', () => {
    expect(mediaScheme.privileges).toEqual({
      standard: true,
      secure: true,
      stream: true,
      corsEnabled: true,
    })
  })
})

describe('MediaGrants', () => {
  it('finds a grant, and waits a moment for one that crosses the other channel', async () => {
    const grants = new MediaGrants(1_000)
    grants.add(grant(0, '/a.png'))
    expect(await grants.find(token(0))).toMatchObject({ path: '/a.png' })
    const later = grants.find(token(1))
    grants.add(grant(1, '/b.png'))
    expect(await later).toMatchObject({ path: '/b.png' })
  })

  it('answers null for a token no grant arrives for', async () => {
    expect(await new MediaGrants(5).find(token(2))).toBeNull()
  })

  it('drops the grants of a session, or every grant', async () => {
    const grants = new MediaGrants(0)
    grants.add(grant(0, '/a.png', 's1'))
    grants.add(grant(1, '/b.png', 's2'))
    grants.revoke('s1')
    expect(await grants.find(token(0))).toBeNull()
    expect(await grants.find(token(1))).not.toBeNull()
    grants.revoke(null)
    expect(await grants.find(token(1))).toBeNull()
  })

  it('keeps the newest 2,000', async () => {
    const grants = new MediaGrants(0)
    // Digits as the letters b to k, so no two numbers make the same token.
    const numbered = (i: number) => String(i).replace(/\d/g, (d) => 'bcdefghijk'[Number(d)]!)
    for (let i = 0; i <= 2_000; i++) {
      grants.add({ ...grant(0, `/${i}.png`), token: numbered(i).padStart(26, 'a') })
    }
    expect(await grants.find(numbered(0).padStart(26, 'a'))).toBeNull()
    expect(await grants.find(numbered(1).padStart(26, 'a'))).not.toBeNull()
  })
})

describe('parseRange', () => {
  it('reads a range, an open end and a suffix', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=990-2000', 1000)).toEqual({ start: 990, end: 999 })
  })

  it('cannot satisfy a range past the end or an empty suffix', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=1000-1001', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable')
  })

  it('serves the whole file for no range, a malformed one or several', () => {
    expect(parseRange(null, 1000)).toBeNull()
    for (const header of ['bytes=-', 'bytes=5-1', 'items=0-1', 'bytes=a-b', 'bytes=0-1,5-9']) {
      expect(parseRange(header, 1000), header).toBeNull()
    }
  })
})

describe('respondMedia', () => {
  let dir: string
  let file: string
  const bytes = Buffer.from('\x89PNG\r\n\x1a\nrest', 'latin1')

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(os.tmpdir(), 'overbench-media-main-')))
    file = join(dir, 'shot.png')
    await writeFile(file, bytes)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const url = (n: number) => `overbench-media://${token(n)}/shot.png?v=1`

  function grants(): MediaGrants {
    const kept = new MediaGrants(0)
    kept.add(grant(0, file))
    return kept
  }

  it('serves a granted file with its type, CORS and hardening headers', async () => {
    const response = await respondMedia(new Request(url(0)), grants())
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'access-control-allow-origin': '*',
      ...HARDENING,
    })
  })

  it('answers HEAD without a body, and refuses other methods and tokens', async () => {
    const head = await respondMedia(new Request(url(0), { method: 'HEAD' }), grants())
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(bytes.length))
    expect((await respondMedia(new Request(url(0), { method: 'POST' }), grants())).status).toBe(405)
    expect((await respondMedia(new Request(url(1)), grants())).status).toBe(404)
    const bad = 'overbench-media://not-a-token/shot.png'
    expect((await respondMedia(new Request(bad), grants())).status).toBe(404)
  })

  it('answers a range with 206 and its Content-Range', async () => {
    const response = await respondMedia(
      new Request(url(0), { headers: { range: 'bytes=4-7' } }),
      grants(),
    )
    expect(response.status).toBe(206)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(4, 8))
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-range': `bytes 4-7/${bytes.length}`,
      'content-length': '4',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      ...HARDENING,
    })
    const suffix = await respondMedia(
      new Request(url(0), { headers: { range: 'bytes=-4' } }),
      grants(),
    )
    expect(suffix.status).toBe(206)
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(-4))
  })

  it('answers 416 past the end, and Accept-Ranges on every answer', async () => {
    const past = await respondMedia(
      new Request(url(0), { headers: { range: `bytes=${bytes.length}-` } }),
      grants(),
    )
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
    expect(past.headers.get('accept-ranges')).toBe('bytes')
    const whole = await respondMedia(new Request(url(0)), grants())
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(whole.headers.get('content-range')).toBeNull()
    expect((await respondMedia(new Request(url(1)), grants())).headers.get('accept-ranges')).toBe(
      'bytes',
    )
  })

  it('closes the file when reading its size fails', async () => {
    const close = vi.fn(async () => {})
    open.mockResolvedValueOnce({
      stat: async () => {
        throw new Error('EIO')
      },
      close,
    })
    expect((await respondMedia(new Request(url(0)), grants())).status).toBe(404)
    expect(close).toHaveBeenCalledOnce()
  })

  posixOnly('refuses a file swapped for a link since the grant', async () => {
    const kept = grants()
    await rename(file, join(dir, 'moved.png'))
    await symlink(join(dir, 'moved.png'), file)
    try {
      expect((await respondMedia(new Request(url(0)), kept)).status).toBe(404)
    } finally {
      await rm(file)
      await rename(join(dir, 'moved.png'), file)
    }
  })
})

describe('grantedPath', () => {
  it('resolves a granted URL to its file, and nothing else', async () => {
    const dir = await realpath(await mkdtemp(join(os.tmpdir(), 'overbench-media-path-')))
    try {
      const file = join(dir, 'demo.mp4')
      await writeFile(file, 'x')
      const grants = new MediaGrants(0)
      grants.add(grant(0, file))
      expect(await grantedPath(`overbench-media://${token(0)}/demo.mp4?v=1`, grants)).toBe(file)
      await expect(grantedPath(`overbench-media://${token(1)}/demo.mp4`, grants)).rejects.toThrow()
      await expect(grantedPath(file, grants)).rejects.toThrow()
      await expect(grantedPath(42, grants)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mayRequestMedia', () => {
  it('lets only the main frame of the app page through', () => {
    expect(mayRequestMedia(frame(APP), isRenderer)).toBe(true)
    expect(mayRequestMedia(frame(APP, frame(APP)), isRenderer)).toBe(false)
    expect(mayRequestMedia(frame('overbench-artifact://x/', frame(APP)), isRenderer)).toBe(false)
    expect(mayRequestMedia(frame('overbench-artifact://x/'), isRenderer)).toBe(false)
    expect(mayRequestMedia(null, isRenderer)).toBe(false)
  })
})

describe('serveMedia', () => {
  function fakeSession() {
    const handle = vi.fn()
    const listeners: ((
      details: OnBeforeRequestListenerDetails,
      callback: (response: CallbackResponse) => void,
    ) => void)[] = []
    const session = {
      protocol: { handle },
      webRequest: {
        onBeforeRequest: (listener: (typeof listeners)[number]) => listeners.push(listener),
      },
    } as unknown as Session
    const cancels = (url: string, from: WebFrameMain | null) =>
      new Promise<boolean>((resolve) =>
        listeners.at(-1)!({ url, frame: from } as OnBeforeRequestListenerDetails, (response) =>
          resolve(response.cancel === true),
        ),
      )
    return { session, handle, listeners, cancels }
  }

  it('handles the scheme and filters it on the session it is given, and on no other', async () => {
    const app = fakeSession()
    const other = fakeSession()
    serveMedia(app.session, new MediaGrants(0), isRenderer)
    expect(app.handle).toHaveBeenCalledWith('overbench-media', expect.any(Function))
    expect(other.handle).not.toHaveBeenCalled()
    expect(other.listeners).toEqual([])
    const media = `overbench-media://${token(0)}/shot.png?v=1`
    expect(await app.cancels(media, frame(APP))).toBe(false)
    expect(await app.cancels(media, frame(APP, frame(APP)))).toBe(true)
    expect(await app.cancels(media, frame('overbench-artifact://x/', frame(APP)))).toBe(true)
    expect(await app.cancels(media, null)).toBe(true)
    expect(await app.cancels('https://example.com/a.png', frame('overbench-artifact://x/'))).toBe(
      false,
    )
  })
})
