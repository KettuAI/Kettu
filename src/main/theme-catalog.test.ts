import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CATALOG_URL,
  parseCatalogIndex,
  readBody,
  ThemeCatalog,
  type CatalogFetch,
} from './theme-catalog'

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

const entry = (fields: Record<string, unknown> = {}) => ({
  id: 'nord',
  name: 'Nord',
  author: 'Arctic Ice Studio',
  version: '1.0.0',
  license: 'MIT',
  file: 'themes/nord.json',
  sha256: 'a'.repeat(64),
  preview: { light: { 'bg-app': '#eceff4' }, dark: { 'bg-app': '#2e3440' } },
  ...fields,
})

const index = (themes: unknown, format: unknown = 1) =>
  JSON.stringify({ kettuCatalog: format, themes })

describe('parseCatalogIndex', () => {
  it('reads each entry with its preview', () => {
    expect(parseCatalogIndex(index([entry()]))).toEqual({ ok: true, entries: [entry()] })
  })

  it('skips entries that fail their checks, and an id seen before', () => {
    const skipped = [
      entry({ id: 'Nord' }),
      entry({ id: 'kettu', file: 'themes/kettu.json' }),
      entry({ file: 'themes/../settings.json' }),
      entry({ file: 'https://example.com/themes/nord.json' }),
      entry({ sha256: 'A'.repeat(64) }),
      entry({ sha256: 'a'.repeat(63) }),
      entry({ name: '  ' }),
      entry({ author: undefined }),
      entry({ version: '1.0' }),
      entry({ license: '' }),
      entry({ license: 'x'.repeat(65) }),
      entry({ name: 'Nord Again' }),
      'nord',
      null,
    ]
    const result = parseCatalogIndex(index([entry(), ...skipped]))
    expect(result).toEqual({ ok: true, entries: [entry()] })
  })

  it('keeps only the colors of the tokens a tile draws', () => {
    const preview = {
      light: { 'bg-app': ' #eceff4 ', 'bg-sidebar': 'url(x)', 'text-primary': '#000' },
      dark: 'none',
      extra: { 'bg-app': '#000' },
    }
    const result = parseCatalogIndex(index([entry({ preview })]))
    expect(result.ok && result.entries[0]!.preview).toEqual({
      light: { 'bg-app': '#eceff4' },
      dark: {},
    })
    const none = parseCatalogIndex(index([entry({ preview: undefined })]))
    expect(none.ok && none.entries[0]!.preview).toEqual({ light: {}, dark: {} })
  })

  it('refuses what is not an index', () => {
    for (const text of ['{', '[]', '{}', index('nord'), index([], 0), index([], '1')]) {
      expect(parseCatalogIndex(text)).toEqual({ ok: false, error: 'invalid' })
    }
    expect(parseCatalogIndex(index([], 2))).toEqual({ ok: false, error: 'newer-format' })
  })
})

describe('readBody', () => {
  it('reads the body, or null once it is larger than the limit', async () => {
    expect(await readBody(new Response('abc'), 3)).toEqual(Buffer.from('abc'))
    expect(await readBody(new Response('abcd'), 3)).toBeNull()
    expect(await readBody(new Response(null), 3)).toEqual(Buffer.alloc(0))
  })
})

describe('ThemeCatalog', () => {
  const file = '{"kettuTheme":1}'

  /** A catalog whose fetch answers from `served`: a body, a status, or an error to throw. */
  function catalog(served: Record<string, string | Buffer | number | Error>) {
    const fetch = vi.fn<CatalogFetch>(async (url) => {
      const answer = served[url.slice(CATALOG_URL.length)]
      if (answer instanceof Error) throw answer
      if (answer === undefined || typeof answer === 'number') {
        return new Response(null, { status: answer ?? 404 })
      }
      return new Response(answer)
    })
    return { catalog: new ThemeCatalog(fetch), fetch }
  }

  it('reads the index from the repository and keeps it until asked to refresh', async () => {
    const { catalog: themes, fetch } = catalog({ 'index.json': index([entry()]) })
    expect(await themes.index(false)).toEqual({ ok: true, entries: [entry()] })
    expect(fetch).toHaveBeenCalledWith(`${CATALOG_URL}index.json`, {
      cache: 'no-cache',
      signal: expect.any(AbortSignal),
    })
    expect(themes.find('nord')).toEqual(entry())
    await themes.index(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    await themes.index(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('says why the index cannot be read, and forgets the last one', async () => {
    const cases: [string | Buffer | number | Error, string][] = [
      [new Error('net::ERR_INTERNET_DISCONNECTED'), 'unreachable'],
      [503, 'unreachable'],
      [Buffer.from([0x7b, 0xe9, 0x7d]), 'invalid'],
      [' '.repeat(1024 * 1024 + 1), 'invalid'],
      [index([], 2), 'newer-format'],
    ]
    for (const [answer, error] of cases) {
      const served: Record<string, string | Buffer | number | Error> = {
        'index.json': index([entry()]),
      }
      const { catalog: themes } = catalog(served)
      await themes.index(true)
      served['index.json'] = answer
      expect(await themes.index(true)).toEqual({ ok: false, error })
      expect(themes.find('nord')).toBeUndefined()
    }
  })

  it('downloads a file only when it matches the SHA-256 in the index', async () => {
    const { catalog: themes, fetch } = catalog({ 'themes/nord.json': file })
    expect(await themes.download(entry({ sha256: sha256(file) }))).toEqual(Buffer.from(file))
    expect(fetch).toHaveBeenCalledWith(`${CATALOG_URL}themes/nord.json`, expect.any(Object))
    expect(await themes.download(entry())).toEqual({ code: 'mismatch' })
  })

  it('refuses a file it cannot download, or one over 256 KB', async () => {
    const big = ' '.repeat(256 * 1024 + 1)
    const { catalog: themes } = catalog({ 'themes/big.json': big })
    expect(await themes.download(entry())).toEqual({ code: 'unreachable' })
    expect(await themes.download(entry({ file: 'themes/big.json', sha256: sha256(big) }))).toEqual({
      code: 'too-large',
    })
  })
})
