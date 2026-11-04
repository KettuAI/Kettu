import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArtifactContentFile } from '@shared/host-control'
import { respond, type ArtifactSource } from './protocol'
import { ViewerFiles } from './viewers'

const HOST = '0123456789abcdef0123456789'
const ORIGIN = `kettu-artifact://${HOST}`
const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

let dir: string
let asked: (number | null)[]
let source: ArtifactSource

function file(name: string, bytes: string | Buffer): ArtifactContentFile {
  const at = path.join(dir, 'content', name)
  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, bytes)
  return { path: name, file: at, size: Buffer.byteLength(bytes) }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-protocol-'))
  asked = []
  const outside = path.join(dir, 'outside.txt')
  writeFileSync(outside, 'secret')
  const files = [
    file('index.html', '<html><head></head><body><section data-page="A"></section></body></html>'),
    file('styles/app.css', 'p{}'),
    file('img/my photo.png', Buffer.from([0x89, 0x50])),
    file('data.bin', Buffer.from([0, 1, 2])),
    { path: 'leak.txt', file: outside, size: 6 },
  ]
  source = {
    contentDir: path.join(dir, 'content'),
    artifactOf: (host) => (host === HOST ? ID : undefined),
    content: async (_, version) => {
      asked.push(version)
      return { kind: 'found', version: version ?? 3, title: 'T', key: 'k', files }
    },
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const get = (url: string) => respond(new Request(url), source)

describe('the artifact protocol', () => {
  it("serves a version's files under its path, each with its type and the artifact policy", async () => {
    const page = await get(`${ORIGIN}/_kettu/v/2/index.html`)
    expect(page.status).toBe(200)
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    const css = await get(`${ORIGIN}/_kettu/v/2/styles/app.css`)
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe('p{}')
    expect(asked).toEqual([2, 2])
  })

  it('serves the latest version at the root, and a folder as its index.html', async () => {
    const page = await get(`${ORIGIN}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('data-page')
    expect(asked).toEqual([null])
  })

  it('serves an unknown type as bytes the page may not sniff, and decodes escaped paths', async () => {
    const bin = await get(`${ORIGIN}/data.bin`)
    expect(bin.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(bin.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const image = await get(`${ORIGIN}/_kettu/v/1/img/my%20photo.png`)
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/png')
  })

  it.each([
    '/missing.css',
    '/_kettu/runtime.js',
    '/_kettu/v/0/index.html',
    '/_kettu/v/x/index.html',
    '/_kettu/v/2',
    '/styles/../../outside.txt',
    '/%E0%A4%A.css',
    '/leak.txt',
  ])('answers %s with not found', async (pathname) => {
    expect((await get(`${ORIGIN}${pathname}`)).status).toBe(404)
  })

  it('refuses another origin and any method but GET', async () => {
    expect((await get('kettu-artifact://ffffffffffffffffffffffffff/')).status).toBe(404)
    expect((await respond(new Request(`${ORIGIN}/`, { method: 'POST' }), source)).status).toBe(405)
  })

  it('shows one page of the entry page alone when asked', async () => {
    const page = await (await get(`${ORIGIN}/_kettu/v/1/index.html?page=0.1`)).text()
    expect(page).toContain('<style>')
    expect((await get(`${ORIGIN}/_kettu/v/1/index.html?page=x`)).status).toBe(404)
    const css = await get(`${ORIGIN}/_kettu/v/1/styles/app.css?page=x`)
    expect(await css.text()).toBe('p{}')
  })
})

describe('the artifact protocol for a typed artifact', () => {
  it("serves its type's viewer in place of index.html, and the viewer's files beside it", async () => {
    const viewers = path.join(dir, 'viewers')
    mkdirSync(path.join(viewers, 'chunks'), { recursive: true })
    writeFileSync(path.join(viewers, 'document.js'), 'export {}')
    writeFileSync(path.join(viewers, 'chunks', 'a.js'), 'export {}')
    const files = [file('document.md', '# Hi')]
    const typed: ArtifactSource = {
      ...source,
      viewers: new ViewerFiles(viewers),
      locale: () => 'zh-CN',
      content: async (_, version) => ({
        kind: 'found',
        version: version ?? 3,
        title: 'T',
        key: 'k',
        files,
        type: { name: 'document', format: 1 },
      }),
    }
    const at = (pathname: string) => respond(new Request(`${ORIGIN}${pathname}`), typed)
    const latest = await at('/')
    expect(latest.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    const html = await latest.text()
    expect(html).toContain('src="_kettu/viewer/document.js"')
    expect(html).toContain('"version":3')
    expect(html).toContain('"locale":"zh-CN"')
    const older = await (await at('/_kettu/v/2/index.html')).text()
    expect(older).toContain('src="../../../_kettu/viewer/document.js"')
    expect(older).toContain('"version":2')
    const chunk = await at('/_kettu/viewer/chunks/a.js')
    expect(chunk.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(await chunk.text()).toBe('export {}')
    expect(await (await at('/document.md')).text()).toBe('# Hi')
    expect((await at('/_kettu/viewer/missing.js')).status).toBe(404)
    expect((await at('/_kettu/viewer/../outside.txt')).status).toBe(404)
  })
})
