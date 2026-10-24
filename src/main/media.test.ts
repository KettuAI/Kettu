import { mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import type { WebFrameMain } from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MediaGrantRecord } from '@shared/media'
import { MediaGrants, mayRequestMedia, respondMedia } from './media'

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

  it('serves a granted file with its type and hardening headers', async () => {
    const response = await respondMedia(new Request(url(0)), grants())
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
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

describe('mayRequestMedia', () => {
  const isRenderer = (url: string | undefined) => url === 'http://localhost:5173/'
  const frame = (url: string, parent: unknown = null) => ({ url, parent }) as WebFrameMain

  it('lets only the main frame of the app page through', () => {
    expect(mayRequestMedia(frame('http://localhost:5173/'), isRenderer)).toBe(true)
    expect(mayRequestMedia(frame('http://localhost:5173/', frame('x')), isRenderer)).toBe(false)
    expect(mayRequestMedia(frame('overbench-artifact://x/'), isRenderer)).toBe(false)
    expect(mayRequestMedia(null, isRenderer)).toBe(false)
  })
})
