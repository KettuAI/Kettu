import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaService } from './media'

const PNG = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')

describe('MediaService.open', () => {
  let base: string
  let root: string
  let outside: string
  let thread: string

  const service = () =>
    new MediaService({
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      homeDir: base,
      names: async (_sessionId, text) => thread.includes(text),
      grant: () => {},
    })

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-media-')))
    root = path.join(base, 'project')
    outside = path.join(base, 'shots')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(path.join(root, 'inside.png'), PNG)
    await writeFile(path.join(outside, 'before.png'), PNG)
    thread = ''
  })

  afterEach(() => rm(base, { recursive: true, force: true }))

  it('grants a file in the session folder', async () => {
    expect((await service().open(root, 'inside.png', 's')).kind).toBe('granted')
  })

  it('refuses a file outside the folder that the thread does not name', async () => {
    const result = await service().open(root, path.join(outside, 'before.png'), 's')
    expect(result.kind).toBe('forbidden')
  })

  it('grants a file outside the folder that the thread names in full', async () => {
    const file = path.join(outside, 'before.png')
    thread = `Saved to \`${file}\`.`
    expect((await service().open(root, file, 's')).kind).toBe('granted')
  })

  it('grants a file outside the folder whose folder and name the thread names', async () => {
    const folder = outside + path.sep
    thread = `Saved in \`${folder}\`: \`before.png\`.`
    expect((await service().open(root, folder + 'before.png', 's')).kind).toBe('granted')
  })

  it('refuses a file whose folder the thread names without its name', async () => {
    const folder = outside + path.sep
    thread = `Saved in \`${folder}\`.`
    expect((await service().open(root, folder + 'before.png', 's')).kind).toBe('forbidden')
  })

  it('refuses a file whose name the thread names without its folder', async () => {
    thread = 'Saved `before.png`.'
    const result = await service().open(root, path.join(outside, 'before.png'), 's')
    expect(result.kind).toBe('forbidden')
  })

  it('refuses a folder the thread names only as a shorter path', async () => {
    thread = `Saved in \`${base + path.sep}\`: \`before.png\`.`
    const result = await service().open(root, path.join(outside, 'before.png'), 's')
    expect(result.kind).toBe('forbidden')
  })
})

const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'latin1')

describe('documents', () => {
  let base: string
  let root: string
  let outside: string
  let thread: string
  const granted: string[] = []

  const service = () =>
    new MediaService({
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      homeDir: base,
      names: async (_sessionId, text) => thread.includes(text),
      grant: (record) => granted.push(record.mimeType),
    })

  const grantFile = async (file: string, sessionId: string | null, documents?: boolean) => {
    const real = await realpath(file)
    return service().grantFile(real, await stat(real), sessionId, documents)
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-documents-')))
    root = path.join(base, 'project')
    outside = path.join(base, 'elsewhere')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(path.join(root, 'paper.pdf'), PDF)
    await writeFile(path.join(root, 'fake.pdf'), 'just text, not a PDF')
    await writeFile(path.join(root, 'paper.bin'), PDF)
    await writeFile(path.join(root, 'late.pdf'), Buffer.concat([Buffer.alloc(900, 0x20), PDF]))
    await writeFile(path.join(root, 'too-late.pdf'), Buffer.concat([Buffer.alloc(1100, 0x20), PDF]))
    await writeFile(path.join(outside, 'paper.pdf'), PDF)
    thread = ''
    granted.length = 0
  })

  afterEach(() => rm(base, { recursive: true, force: true }))

  it('grants a PDF to the Files pane by its first bytes', async () => {
    const grant = await grantFile(path.join(root, 'paper.pdf'), null, true)
    expect(grant).toMatchObject({
      kind: 'document',
      mimeType: 'application/pdf',
      size: PDF.length,
    })
    expect(grant?.url).toMatch(/^kettu-media:\/\/[a-z2-7]{26}\/paper\.pdf\?v=\d+$/)
    expect(granted).toEqual(['application/pdf'])
  })

  it('accepts the signature anywhere in the first kilobyte, and not past it', async () => {
    expect(await grantFile(path.join(root, 'late.pdf'), null, true)).not.toBeNull()
    expect(await grantFile(path.join(root, 'too-late.pdf'), null, true)).toBeNull()
  })

  it('refuses a .pdf whose bytes are no PDF, and a PDF without the name', async () => {
    expect(await grantFile(path.join(root, 'fake.pdf'), null, true)).toBeNull()
    expect(await grantFile(path.join(root, 'paper.bin'), null, true)).toBeNull()
    expect(granted).toEqual([])
  })

  it('grants no document unless the Files pane asks for them', async () => {
    expect(await grantFile(path.join(root, 'paper.pdf'), null)).toBeNull()
    expect(granted).toEqual([])
  })

  it('never grants a document to the conversation', async () => {
    const real = path.join(root, 'paper.pdf')
    expect(await service().open(root, real, 's')).toEqual({ kind: 'not_media' })
    expect(await service().open(root, 'paper.pdf', 's')).toEqual({ kind: 'not_media' })
    expect(granted).toEqual([])
  })

  it('never grants a document the thread names outside the folder', async () => {
    const file = path.join(outside, 'paper.pdf')
    thread = `Saved to \`${file}\`.`
    expect(await service().open(root, file, 's')).toEqual({ kind: 'not_media' })
    expect(await service().authorize(root, file, 's')).toEqual({ kind: 'not_media' })
  })

  it('authorizes a document for a device only without a session, inside the folder', async () => {
    const files = await service().authorize(root, 'paper.pdf', null)
    expect(files).toMatchObject({
      kind: 'granted',
      file: { kind: 'document', mimeType: 'application/pdf', name: 'paper.pdf' },
    })
    expect(await service().authorize(root, 'paper.pdf', 's')).toEqual({ kind: 'not_media' })
    const file = path.join(outside, 'paper.pdf')
    expect(await service().authorize(root, file, null)).toEqual({ kind: 'forbidden' })
    thread = file
    expect(await service().authorize(root, file, null)).toEqual({ kind: 'forbidden' })
  })

  it('describes a document for the Files pane only on request', async () => {
    const real = path.join(root, 'paper.pdf')
    const info = await stat(real)
    expect(await service().describe(real, info)).toBeNull()
    expect(await service().describe(real, info, true)).toMatchObject({ kind: 'document' })
  })
})

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS = 'application/vnd.ms-excel'
const OLE2 = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(512),
])

function zip(entries: Record<string, string | Buffer>, comment?: string): Promise<Buffer> {
  const archive = new JSZip()
  for (const [name, content] of Object.entries(entries)) {
    archive.file(name, content, { compression: 'STORE' })
  }
  return archive.generateAsync({ type: 'nodebuffer', comment })
}

describe('Word and Excel documents', () => {
  let base: string
  let root: string
  let outside: string
  let thread: string
  const granted: string[] = []

  const service = () =>
    new MediaService({
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      homeDir: base,
      names: async (_sessionId, text) => thread.includes(text),
      grant: (record) => granted.push(record.mimeType),
    })

  const grantFile = async (file: string, sessionId: string | null, documents?: boolean) => {
    const real = await realpath(file)
    return service().grantFile(real, await stat(real), sessionId, documents)
  }

  const put = (name: string, bytes: string | Buffer, folder = root) =>
    writeFile(path.join(folder, name), bytes)

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-office-')))
    root = path.join(base, 'project')
    outside = path.join(base, 'elsewhere')
    await mkdir(root)
    await mkdir(outside)
    const word = await zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w/>' })
    const sheet = await zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<wb/>' })
    await put('report.docx', word)
    await put('numbers.xlsx', sheet)
    await put('old.xls', OLE2)
    await put('protected.docx', OLE2)
    await put('protected.xlsx', OLE2)
    await put('commented.docx', await zip({ 'word/document.xml': '<w/>' }, 'x'.repeat(5000)))
    // The entry is far past the first 64 KB, so only the central directory names it.
    await put(
      'big.docx',
      await zip({ 'word/media/a.bin': Buffer.alloc(200_000, 7), 'word/document.xml': '<w/>' }),
    )
    await put('fake.docx', 'just text, not a Word file')
    await put('fake.xlsx', 'just text, not a workbook')
    await put('fake.xls', 'just text, not a workbook')
    await put('zipped.xls', sheet)
    await put('report.bin', word)
    await put('numbers.bin', sheet)
    await put('other.docx', await zip({ 'xl/workbook.xml': '<wb/>' }))
    await put('other.xlsx', await zip({ 'word/document.xml': '<w/>' }))
    await put('plain.xlsx', await zip({ 'readme.txt': 'hello' }))
    await put('cut.docx', word.subarray(0, word.length - 30))
    await put('report.docx', word, outside)
    thread = ''
    granted.length = 0
  })

  afterEach(() => rm(base, { recursive: true, force: true }))

  it('grants Word and Excel files to the Files pane by their first bytes', async () => {
    const word = await grantFile(path.join(root, 'report.docx'), null, true)
    expect(word).toMatchObject({ kind: 'document', mimeType: DOCX })
    expect(word?.url).toMatch(/^kettu-media:\/\/[a-z2-7]{26}\/report\.docx\?v=\d+$/)
    expect(await grantFile(path.join(root, 'numbers.xlsx'), null, true)).toMatchObject({
      kind: 'document',
      mimeType: XLSX,
    })
    expect(await grantFile(path.join(root, 'old.xls'), null, true)).toMatchObject({
      kind: 'document',
      mimeType: XLS,
    })
    expect(granted).toEqual([DOCX, XLSX, XLS])
  })

  it('grants a protected file, which is stored as an OLE2 container, as its name says', async () => {
    expect((await grantFile(path.join(root, 'protected.docx'), null, true))?.mimeType).toBe(DOCX)
    expect((await grantFile(path.join(root, 'protected.xlsx'), null, true))?.mimeType).toBe(XLSX)
  })

  it('finds the entry through the central directory, past a comment and past 64 KB', async () => {
    expect(await grantFile(path.join(root, 'commented.docx'), null, true)).not.toBeNull()
    expect(await grantFile(path.join(root, 'big.docx'), null, true)).not.toBeNull()
  })

  it('refuses a name whose bytes are of another kind', async () => {
    for (const name of ['fake.docx', 'fake.xlsx', 'fake.xls', 'zipped.xls']) {
      expect(await grantFile(path.join(root, name), null, true)).toBeNull()
    }
    expect(granted).toEqual([])
  })

  it('refuses a file with the right bytes but no Office name', async () => {
    expect(await grantFile(path.join(root, 'report.bin'), null, true)).toBeNull()
    expect(await grantFile(path.join(root, 'numbers.bin'), null, true)).toBeNull()
  })

  it('refuses an archive that holds another kind of file', async () => {
    for (const name of ['other.docx', 'other.xlsx', 'plain.xlsx']) {
      expect(await grantFile(path.join(root, name), null, true)).toBeNull()
    }
  })

  it('refuses an archive whose central directory is cut off', async () => {
    expect(await grantFile(path.join(root, 'cut.docx'), null, true)).toBeNull()
  })

  it('refuses a central directory that claims more than a file this size holds', async () => {
    const end = Buffer.alloc(22)
    end.write('PK\x05\x06', 0, 'latin1')
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(0x00ffffff, 12)
    end.writeUInt32LE(0, 16)
    await put('lying.docx', Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), end]))
    expect(await grantFile(path.join(root, 'lying.docx'), null, true)).toBeNull()
  })

  it('grants none of them unless the Files pane asks for documents', async () => {
    expect(await grantFile(path.join(root, 'report.docx'), null)).toBeNull()
    expect(await grantFile(path.join(root, 'numbers.xlsx'), null)).toBeNull()
    expect(await grantFile(path.join(root, 'old.xls'), null)).toBeNull()
    expect(granted).toEqual([])
  })

  it('never grants them to the conversation', async () => {
    for (const name of ['report.docx', 'numbers.xlsx', 'old.xls']) {
      expect(await service().open(root, name, 's')).toEqual({ kind: 'not_media' })
      expect(await service().open(root, path.join(root, name), 's')).toEqual({ kind: 'not_media' })
      expect(await service().authorize(root, name, 's')).toEqual({ kind: 'not_media' })
    }
    expect(granted).toEqual([])
  })

  it('never grants one the thread names outside the folder', async () => {
    const file = path.join(outside, 'report.docx')
    thread = `Saved to \`${file}\`.`
    expect(await service().open(root, file, 's')).toEqual({ kind: 'not_media' })
    expect(await service().authorize(root, file, 's')).toEqual({ kind: 'not_media' })
    expect(await service().authorize(root, file, null)).toEqual({ kind: 'forbidden' })
  })

  it('authorizes them for a device only without a session, inside the folder', async () => {
    expect(await service().authorize(root, 'report.docx', null)).toMatchObject({
      kind: 'granted',
      file: { kind: 'document', mimeType: DOCX, name: 'report.docx' },
    })
    expect(await service().authorize(root, 'numbers.xlsx', null)).toMatchObject({
      kind: 'granted',
      file: { kind: 'document', mimeType: XLSX },
    })
    expect(await service().authorize(root, 'old.xls', null)).toMatchObject({
      kind: 'granted',
      file: { kind: 'document', mimeType: XLS },
    })
  })
})
