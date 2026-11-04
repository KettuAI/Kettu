import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactFrames, MAX_FRAMES } from './frames'
import { HandshakeLimits } from './limits'
import { WebServer } from './web'

const TOKEN = 'A'.repeat(43)

let dir: string
let listener: Server
let web: WebServer
let base: string
let asked: { version: number | null; path: string }[]
let strict: boolean

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-web-frames-'))
  const files: Record<string, string> = {
    'index.html': '<!doctype html><html><head></head><body><p>hi</p></body></html>',
    'style.css': 'p{}',
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
  asked = []
  strict = false
  web = new WebServer({
    root: null,
    server: {
      accept: () => {},
      refusedOne: () => {},
      frameFile: async (token, version, wanted) => {
        asked.push({ version, path: wanted })
        const text = token === TOKEN ? files[wanted] : undefined
        return text === undefined
          ? null
          : { file: path.join(dir, wanted), size: text.length, strict }
      },
    },
    limits: new HandshakeLimits(),
    log: () => {},
  })
  listener = createServer((socket) => web.take(socket))
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  web.endAll()
  await new Promise((resolve) => listener.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe("the direct port's artifact frames", () => {
  it("serves a frame's files with their types, sandboxed to the frame's own folder", async () => {
    const page = await fetch(`${base}/frame/${TOKEN}/_kettu/v/2/index.html?page=0.1`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain('<style>')
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toMatch(/^sandbox allow-scripts /)
    const own = `${new URL(base).host}/frame/${TOKEN}/`
    expect(csp).toContain(`script-src ${own} 'unsafe-inline'`)
    expect(csp).toContain(`connect-src ${own} `)
    expect(csp).not.toContain("'self' ")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    const css = await fetch(`${base}/frame/${TOKEN}/style.css`, { headers: { Origin: 'null' } })
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('x-content-type-options')).toBe('nosniff')
    expect(css.headers.get('access-control-allow-origin')).toBe('null')
    expect(css.headers.get('cross-origin-resource-policy')).toBeNull()
    expect(await css.text()).toBe('p{}')
    expect(asked).toEqual([
      { version: 2, path: 'index.html' },
      { version: null, path: 'style.css' },
    ])
  })

  it('names no CDN in the frames of an artifact that reads beyond it', async () => {
    const loose = await fetch(`${base}/frame/${TOKEN}/index.html`)
    expect(loose.headers.get('content-security-policy')).toContain('https://cdn.jsdelivr.net')
    strict = true
    const tight = (await fetch(`${base}/frame/${TOKEN}/index.html`)).headers.get(
      'content-security-policy',
    )!
    expect(tight).toMatch(/^sandbox allow-scripts /)
    expect(tight).not.toContain('https:')
    expect(tight).toContain(`connect-src ${new URL(base).host}/frame/${TOKEN}/;`)
  })

  it.each([
    `/frame/${'B'.repeat(43)}/index.html`,
    `/frame/${TOKEN}/missing.css`,
    `/frame/${TOKEN}/_kettu/runtime.js`,
  ])('answers %s with not found, which the frame may read', async (pathname) => {
    const missing = await fetch(`${base}${pathname}`, { headers: { Origin: 'null' } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe('null')
  })
})

describe('the frames a session opens', () => {
  it('lasts until closed by its session, or until the session ends', () => {
    const frames = new ArtifactFrames<string>()
    const one = frames.open('a', 'art_1')
    const two = frames.open('a', 'art_2')
    const other = frames.open('b', 'art_1')
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(frames.find(one)).toEqual({ session: 'a', artifactId: 'art_1', lax: false })
    frames.close('b', one)
    expect(frames.find(one)).toBeDefined()
    frames.close('a', one)
    expect(frames.find(one)).toBeUndefined()
    frames.closeAll('a')
    expect(frames.find(two)).toBeUndefined()
    expect(frames.find(other)).toBeDefined()
    expect(frames.find('../x')).toBeUndefined()
  })

  it('closes the oldest of a session past its limit', () => {
    const frames = new ArtifactFrames<string>()
    const first = frames.open('a', 'art_1')
    for (let i = 1; i < MAX_FRAMES; i++) frames.open('a', 'art_1')
    expect(frames.find(first)).toBeDefined()
    frames.open('a', 'art_1')
    expect(frames.find(first)).toBeUndefined()
  })
})
