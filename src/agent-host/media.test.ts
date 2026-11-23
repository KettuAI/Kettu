import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
