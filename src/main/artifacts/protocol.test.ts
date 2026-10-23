import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactContentResult } from '@shared/host-control'
import { ARTIFACT_CSP } from './policy'

vi.mock('electron', () => ({ protocol: {} }))

const { pageStyle, parseRequest, respond, withStyle } = await import('./protocol')

const HOST = '0123456789abcdef0123456789'
const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW'
const ORIGIN = `overbench-artifact://${HOST}`
const artifactOf = (host: string): string | undefined => (host === HOST ? ID : undefined)

describe('parseRequest', () => {
  it.each([
    ['/', { id: ID, version: null, page: null }],
    ['/index.html', { id: ID, version: null, page: null }],
    ['/?v=3', { id: ID, version: 3, page: null }],
    ['/?page=0.2', { id: ID, version: null, page: { group: 0, index: 2 } }],
    ['/?v=2&page=1.12', { id: ID, version: 2, page: { group: 1, index: 12 } }],
    ['/?utm=x', { id: ID, version: null, page: null }],
  ])('reads %s', (path, wanted) => {
    expect(parseRequest(`${ORIGIN}${path}`, artifactOf)).toEqual(wanted)
  })

  it.each([
    '/app.js',
    '/index.htm',
    '//',
    '/.env',
    '/?v=0',
    '/?v=01',
    '/?v=-1',
    '/?v=1.5',
    '/?v=1e3',
    '/?v=1&v=2',
    '/?page=1',
    '/?page=1.0',
    '/?page=a.b',
    '/?page=1.2.3',
    '/?page=1.2%3Cstyle%3E',
    '/?page=1.2&page=1.3',
  ])('refuses %s', (path) => {
    expect(parseRequest(`${ORIGIN}${path}`, artifactOf)).toBeNull()
  })

  it('refuses an origin that was not opened, and every other scheme', () => {
    expect(parseRequest('overbench-artifact://ffffffffffffffffffffffffff/', artifactOf)).toBeNull()
    expect(parseRequest(`https://${HOST}/`, artifactOf)).toBeNull()
  })
})

describe('withStyle', () => {
  it('adds the style at the end of the head', () => {
    expect(withStyle('<html><head><title>x</title></HEAD><body>', 'a{}')).toBe(
      '<html><head><title>x</title><style>a{}</style></HEAD><body>',
    )
  })

  it('puts it before the body, or after the doctype, when there is no head', () => {
    expect(withStyle('<!doctype html><body class="x">', 'a{}')).toBe(
      '<!doctype html><style>a{}</style><body class="x">',
    )
    expect(withStyle('<!DOCTYPE html>\n<p>hi', 'a{}')).toBe(
      '<!DOCTYPE html><style>a{}</style>\n<p>hi',
    )
    expect(withStyle('<p>hi', 'a{}')).toBe('<style>a{}</style><p>hi')
  })
})

describe('pageStyle', () => {
  it('shows one page outside a group, or one page of a group, and nothing else', () => {
    expect(pageStyle(0, 3)).toContain('body>:not(:nth-child(3 of [data-page]))')
    const grouped = pageStyle(2, 1)
    expect(grouped).toContain('body>:not(:nth-child(2 of [data-page-group]))')
    expect(grouped).toContain(
      'body>:nth-child(2 of [data-page-group])>:not(:nth-child(1 of [data-page]))',
    )
    expect(grouped).toContain('margin:0!important')
  })
})

describe('respond', () => {
  let dir: string
  let contentDir: string
  let found: ArtifactContentResult
  const asked: [string, number | null][] = []

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-protocol-'))
    contentDir = path.join(dir, 'artifacts', 'content')
    await mkdir(path.join(contentDir, 'ab'), { recursive: true })
    const file = path.join(contentDir, 'ab', `ab${'0'.repeat(62)}.html`)
    await writeFile(file, '<html><head></head><body><section data-page="A">A</section></body>')
    await writeFile(path.join(dir, 'secret.txt'), 'secret')
    found = { kind: 'found', path: file, version: 2 }
    asked.length = 0
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const source = () => ({
    contentDir,
    artifactOf,
    content: async (id: string, version: number | null) => {
      asked.push([id, version])
      return found
    },
  })

  it('streams the HTML with the headers', async () => {
    const response = await respond(new Request(`${ORIGIN}/?v=2`), source())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(ARTIFACT_CSP)
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(await response.text()).toContain('data-page="A"')
    expect(asked).toEqual([[ID, 2]])
  })

  it('adds the single-page style for ?page', async () => {
    const response = await respond(new Request(`${ORIGIN}/?page=0.1`), source())
    expect(await response.text()).toContain(`<style>${pageStyle(0, 1)}</style></head>`)
  })

  it('answers 404, with the headers, for what it does not serve', async () => {
    for (const url of [`${ORIGIN}/secret.txt`, `${ORIGIN}/../secret.txt`, `${ORIGIN}/%2e%2e/x`]) {
      const response = await respond(new Request(url), source())
      expect(response.status).toBe(404)
      expect(response.headers.get('content-security-policy')).toBe(ARTIFACT_CSP)
    }
    expect(asked).toEqual([])
  })

  it('answers 404 for an unknown version and 503 when the host cannot say', async () => {
    found = { kind: 'not_found' }
    expect((await respond(new Request(`${ORIGIN}/?v=9`), source())).status).toBe(404)
    found = { kind: 'failed' }
    expect((await respond(new Request(`${ORIGIN}/`), source())).status).toBe(503)
  })

  it('refuses a file outside the content folder, whatever the host says', async () => {
    found = { kind: 'found', path: path.join(dir, 'secret.txt'), version: 1 }
    const response = await respond(new Request(`${ORIGIN}/`), source())
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('secret')
    found = { kind: 'found', path: path.join(contentDir, '..', 'content-x', 'a.html'), version: 1 }
    expect((await respond(new Request(`${ORIGIN}/`), source())).status).toBe(404)
  })

  it('answers only GET', async () => {
    const response = await respond(new Request(`${ORIGIN}/`, { method: 'POST' }), source())
    expect(response.status).toBe(405)
  })
})
