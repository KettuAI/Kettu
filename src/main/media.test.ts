import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCX_TYPE, XLS_TYPE, XLSX_TYPE } from '@shared/media'
import { MediaGrants, respondMedia } from './media'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz'
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n', 'latin1')

describe('respondMedia for a PDF', () => {
  let folder: string
  let file: string
  let grants: MediaGrants

  const get = (headers: Record<string, string> = {}, method = 'GET') =>
    respondMedia(new Request(`kettu-media://${TOKEN}/paper.pdf?v=1`, { method, headers }), grants)

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-serve-')))
    file = path.join(folder, 'paper.pdf')
    await writeFile(file, PDF)
    grants = new MediaGrants(10)
    grants.add({ token: TOKEN, path: file, mimeType: 'application/pdf', sessionId: null })
  })

  afterEach(() => rm(folder, { recursive: true, force: true }))

  it('serves the file as a PDF that is never sniffed into anything else', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    // The page's range loading reads these from the answer.
    expect(response.headers.get('access-control-expose-headers')).toContain('Accept-Ranges')
    expect(response.headers.get('access-control-expose-headers')).toContain('Content-Range')
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true)
  })

  it('answers a range with only those bytes', async () => {
    const response = await get({ range: 'bytes=2-9' })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 2-9/${PDF.length}`)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF.subarray(2, 10))).toBe(true)
  })

  it('answers the last bytes of a suffix range, and a range past the end with 416', async () => {
    const tail = await get({ range: 'bytes=-4' })
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer()).equals(PDF.subarray(PDF.length - 4))).toBe(true)
    const past = await get({ range: `bytes=${PDF.length}-` })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe(`bytes */${PDF.length}`)
  })

  it('answers a HEAD with the size and no body', async () => {
    const response = await get({}, 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PDF.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('')
  })

  it('refuses a token it never granted', async () => {
    const response = await respondMedia(
      new Request('kettu-media://zyxwvutsrqponmlkjihgfedcba/paper.pdf'),
      grants,
    )
    expect(response.status).toBe(404)
  })

  it('refuses a file swapped for a link since it was granted', async () => {
    await rm(file)
    await writeFile(path.join(folder, 'other.pdf'), PDF)
    const { symlink } = await import('node:fs/promises')
    await symlink(path.join(folder, 'other.pdf'), file)
    expect((await get()).status).toBe(404)
  })
})

describe('respondMedia for Word and Excel files', () => {
  let folder: string
  let grants: MediaGrants
  const BYTES = Buffer.from('PK\x03\x04 not read here', 'latin1')

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-serve-')))
    grants = new MediaGrants(10)
  })

  afterEach(() => rm(folder, { recursive: true, force: true }))

  it.each([
    ['report.docx', DOCX_TYPE],
    ['numbers.xlsx', XLSX_TYPE],
    ['old.xls', XLS_TYPE],
  ] as const)(
    'serves %s with its own type, never sniffed into anything else',
    async (name, type) => {
      const file = path.join(folder, name)
      await writeFile(file, BYTES)
      grants.add({ token: TOKEN, path: file, mimeType: type, sessionId: null })
      const response = await respondMedia(new Request(`kettu-media://${TOKEN}/${name}?v=1`), grants)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(type)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toContain('sandbox')
      expect(Buffer.from(await response.arrayBuffer()).equals(BYTES)).toBe(true)
    },
  )
})
