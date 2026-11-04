import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MESSAGE_BYTES, type SelectMessage } from '@shared/artifact-runtime/page-messages'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import type { ArtifactContentFile } from '@shared/host-control'
import { ARTIFACT_CSP, ARTIFACT_STRICT_CSP } from './policy'
import { respond, type ArtifactSource } from './protocol'
import { readBody, type RuntimeRelay } from './runtime'
import { ViewerFiles } from './viewers'

const HOST = '0123456789abcdef0123456789'
const ORIGIN = `kettu-artifact://${HOST}`
const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

let dir: string
let asked: (number | null)[]
let source: ArtifactSource
let picks: { host: string; message: SelectMessage }[]
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
  picks = []
  strict = false
  const outside = path.join(dir, 'outside.txt')
  writeFileSync(outside, 'secret')
  const files = [
    file('index.html', '<html><head></head><body><section data-page="A"></section></body></html>'),
    file('typed.html', '<!-- a note -->\n<!DOCTYPE html><p class=x>One</p><script>"<b>"</script>'),
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
    selected: (host, message) => picks.push({ host, message }),
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

const post = (body: string, url = `${ORIGIN}/_kettu/v1`) =>
  respond(new Request(url, { method: 'POST', body }), source)

const pick = {
  v: 1,
  id: 'k1',
  kind: 'select',
  channel: 'abcdefgh12',
  selection: {
    path: 'index.html',
    src: 26,
    tag: 'section',
    text: 'A\n  page',
    textOnly: true,
    style: { color: '#FFFFFF', fontSize: 12.5, textAlign: 'center', padding: [0, 14, 0, 14] },
  },
}

describe('the page runtime on an artifact origin', () => {
  it('comes first in every HTML file, after a doctype, with each start tag marked', async () => {
    const page = await (await get(`${ORIGIN}/`)).text()
    expect(page.startsWith('<script>(()=>{')).toBe(true)
    expect(page).toContain('"transport":"fetch"')
    const mark = /"mark":"([0-9a-z]{8})"/.exec(page)?.[1]
    expect(mark).toBeDefined()
    expect(page).toContain(`<html data-kettu-src="${mark}:0">`)
    expect(page).toContain(`<section data-kettu-src="${mark}:25" data-page="A">`)
    const typed = await (await get(`${ORIGIN}/typed.html`)).text()
    expect(typed.startsWith('<!-- a note -->\n<!DOCTYPE html><script>')).toBe(true)
    expect(typed).toContain('"path":"typed.html"')
    expect(typed).toMatch(/<p data-kettu-src="[0-9a-z]{8}:31" class=x>One<\/p>/)
    // Markup in a script's text is not an element.
    expect(typed).toMatch(/<script data-kettu-src="[0-9a-z]{8}:49">"<b>"<\/script>$/)
  })

  it('marks each response anew, and never a file that is not HTML', async () => {
    const first = /"mark":"(\w+)"/.exec(await (await get(`${ORIGIN}/`)).text())?.[1]
    const second = /"mark":"(\w+)"/.exec(await (await get(`${ORIGIN}/`)).text())?.[1]
    expect(first).not.toBe(second)
    expect(await (await get(`${ORIGIN}/styles/app.css`)).text()).toBe('p{}')
  })

  it('passes a pick on, checked and capped, to the windows of its origin', async () => {
    const answer = await post(JSON.stringify(pick))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ v: 1, id: 'k1', ok: true, value: null })
    expect(picks).toHaveLength(1)
    expect(picks[0]!.host).toBe(HOST)
    expect(picks[0]!.message.selection).toMatchObject({
      path: 'index.html',
      src: 26,
      tag: 'section',
      text: 'A page',
      style: { color: '#ffffff', fontSize: 12.5, textAlign: 'center', padding: [0, 14, 0, 14] },
    })
  })

  it('answers a capability as a client that offers none', async () => {
    const use = await post(JSON.stringify({ v: 1, id: 'k2', kind: 'use', cap: 'db' }))
    expect(await use.json()).toEqual({ v: 1, id: 'k2', ok: true, value: null })
    const call = await post(JSON.stringify({ v: 1, id: 'k3', kind: 'call', cap: 'db', op: 'get' }))
    expect(await call.json()).toMatchObject({ id: 'k3', ok: false, error: { code: 'unsupported' } })
    expect(picks).toEqual([])
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['another version', JSON.stringify({ ...pick, v: 2 })],
    ['a pick without a channel', JSON.stringify({ ...pick, channel: 'x' })],
    [
      'a pick in a file that is not HTML',
      JSON.stringify({ ...pick, selection: { ...pick.selection, path: 'a.css' } }),
    ],
    [
      'a pick of a path outside',
      JSON.stringify({ ...pick, selection: { ...pick.selection, path: '../a.html' } }),
    ],
    [
      'a pick with a tag that is no name',
      JSON.stringify({ ...pick, selection: { ...pick.selection, tag: '<b>' } }),
    ],
    [
      'a pick at no whole offset',
      JSON.stringify({ ...pick, selection: { ...pick.selection, src: 1.5 } }),
    ],
    ['a message too large', JSON.stringify({ ...pick, pad: 'x'.repeat(MESSAGE_BYTES) })],
  ])('refuses %s', async (_, body) => {
    expect((await post(body)).status).toBe(400)
    expect(picks).toEqual([])
  })

  it('takes messages only by POST, and only on an origin it serves', async () => {
    expect((await get(`${ORIGIN}/_kettu/v1`)).status).toBe(405)
    const other = await post(
      JSON.stringify(pick),
      'kettu-artifact://ffffffffffffffffffffffffff/_kettu/v1',
    )
    expect(other.status).toBe(404)
    expect(picks).toEqual([])
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
        strict: false,
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
