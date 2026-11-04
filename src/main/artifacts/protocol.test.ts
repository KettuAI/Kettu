import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import type { ArtifactContentFile } from '@shared/host-control'
import { ARTIFACT_CSP, ARTIFACT_STRICT_CSP } from './policy'
import { respond, type ArtifactSource } from './protocol'
import { readBody, type RuntimeRelay } from './runtime'

const HOST = '0123456789abcdef0123456789'
const ORIGIN = `kettu-artifact://${HOST}`
const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

let dir: string
let asked: (number | null)[]
let source: ArtifactSource
let strict: boolean

function file(name: string, bytes: string | Buffer): ArtifactContentFile {
  const at = path.join(dir, 'content', name)
  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, bytes)
  return { path: name, file: at, size: Buffer.byteLength(bytes) }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-protocol-'))
  asked = []
  strict = false
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
      return { kind: 'found', version: version ?? 3, title: 'T', key: 'k', strict, files }
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

describe("an artifact's policy", () => {
  it('keeps the CDNs out of the pages of an artifact that declares reading beyond it', async () => {
    const declared: [string, boolean][] = []
    source.declared = (id, value) => declared.push([id, value])
    const loose = await get(`${ORIGIN}/`)
    expect(loose.headers.get('Content-Security-Policy')).toBe(ARTIFACT_CSP)
    strict = true
    const tight = await get(`${ORIGIN}/styles/app.css`)
    expect(tight.headers.get('Content-Security-Policy')).toBe(ARTIFACT_STRICT_CSP)
    expect(declared).toEqual([
      [ID, false],
      [ID, true],
    ])
  })
})

describe("the runtime's requests", () => {
  let sent: { artifactId: string; message: unknown }[]
  let reading: string[]
  let cancelled: number
  let answers: (message: { id: string }) => RuntimeAnswer[]

  beforeEach(() => {
    sent = []
    reading = []
    cancelled = 0
    answers = (message) => [{ v: 1, id: message.id, ok: true, value: { ops: ['get'] } }]
    const relay: RuntimeRelay = {
      send(artifactId, message, answer) {
        sent.push({ artifactId, message })
        // The host's answers arrive later, as over the port.
        setTimeout(() => {
          for (const a of answers(message as { id: string })) answer(a)
        }, 0)
        return () => cancelled++
      },
      reading: (artifactId) => reading.push(artifactId),
    }
    source.runtime = relay
  })

  const post = (message: unknown, origin: string | null = ORIGIN) =>
    respond(
      new Request(`${ORIGIN}/_kettu/v1`, {
        method: 'POST',
        body: JSON.stringify(message),
        headers: origin ? { Origin: origin } : {},
      }),
      source,
    )

  it('passes a message to the host with the artifact its origin names', async () => {
    const response = await post({ v: 1, id: 'u1', kind: 'use', cap: 'db' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBe(ARTIFACT_STRICT_CSP)
    expect(await response.json()).toEqual({ v: 1, id: 'u1', ok: true, value: { ops: ['get'] } })
    expect(sent).toEqual([{ artifactId: ID, message: { v: 1, id: 'u1', kind: 'use', cap: 'db' } }])
    expect(reading).toEqual([])
  })

  it("answers with the page's own id, whatever the host put there", async () => {
    answers = () => [{ v: 1, id: 'other', ok: true, value: 1 }]
    const response = await post({ v: 1, id: 'c1', kind: 'call', cap: 'db', op: 'get', args: {} })
    expect(await response.json()).toEqual({ v: 1, id: 'c1', ok: true, value: 1 })
  })

  it('marks the origin as reading beyond it once a page asks for files or sample', async () => {
    await post({ v: 1, id: 'u1', kind: 'use', cap: 'files' })
    await post({ v: 1, id: 'u2', kind: 'use', cap: 'sample' })
    expect(reading).toEqual([ID, ID])
  })

  it('streams events as lines of JSON until the last answer', async () => {
    answers = (message) => [
      { v: 1, id: message.id, event: { type: 'text', text: 'Hi' } },
      { v: 1, id: message.id, event: { type: 'answer', text: 'Hi' } },
      { v: 1, id: message.id, done: true },
    ]
    const response = await post({
      v: 1,
      id: 's1',
      kind: 'stream',
      cap: 'sample',
      op: 'ask',
      args: { prompt: 'Hello' },
    })
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8')
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { v: 1, id: 's1', event: { type: 'text', text: 'Hi' } },
      { v: 1, id: 's1', event: { type: 'answer', text: 'Hi' } },
      { v: 1, id: 's1', done: true },
    ])
  })

  it('cancels the stream at the host when the page drops its request', async () => {
    answers = () => []
    const controller = new AbortController()
    const response = await respond(
      new Request(`${ORIGIN}/_kettu/v1`, {
        method: 'POST',
        body: JSON.stringify({ v: 1, id: 's1', kind: 'stream', cap: 'db', op: 'watch', args: {} }),
        signal: controller.signal,
      }),
      source,
    )
    expect(response.status).toBe(200)
    controller.abort()
    expect(cancelled).toBe(1)
  })

  it('refuses a request from another origin, and every method but POST', async () => {
    const other = await post(
      { v: 1, id: 'u1', kind: 'use', cap: 'db' },
      'kettu-artifact://ffffffffffffffffffffffffff',
    )
    expect(other.status).toBe(404)
    expect((await post({ v: 1, id: 'u1', kind: 'use', cap: 'db' }, 'null')).status).toBe(404)
    expect((await get(`${ORIGIN}/_kettu/v1`)).status).toBe(405)
    expect(sent).toEqual([])
  })

  it("leaves other kinds to the editor's handling and refuses what is not JSON", async () => {
    expect((await post({ v: 1, id: 'x', kind: 'select' })).status).toBe(400)
    const broken = await respond(
      new Request(`${ORIGIN}/_kettu/v1`, { method: 'POST', body: '{' }),
      source,
    )
    expect(broken.status).toBe(400)
    expect(await broken.json()).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(sent).toEqual([])
  })

  it('offers no capability where no runtime serves, as for a thumbnail', async () => {
    source.runtime = null
    expect(await (await post({ v: 1, id: 'u1', kind: 'use', cap: 'db' })).json()).toEqual({
      v: 1,
      id: 'u1',
      ok: true,
      value: null,
    })
    const call = await post({ v: 1, id: 'c1', kind: 'call', cap: 'db', op: 'get', args: {} })
    expect(await call.json()).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })

  it('reads a body only up to the limit', async () => {
    const body = (text: string) =>
      new Request(`${ORIGIN}/_kettu/v1`, { method: 'POST', body: text })
    expect(await readBody(body('x'.repeat(10)), 10)).toBe('x'.repeat(10))
    expect(await readBody(body('x'.repeat(11)), 10)).toBeNull()
  })
})
