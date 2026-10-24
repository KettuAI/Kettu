import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_MAX_AGE_MS,
  Attachments,
  parseAttachmentsFile,
  toArrayBuffer,
  type AttachmentRecord,
} from './attachments'

let grants = 0
/** Grants a path the way main does, and returns the grant's id. */
function grant(attachments: Attachments, granted: string, kind: 'file' | 'folder' = 'file') {
  const grantId = `g${++grants}`
  attachments.grant([{ grantId, path: granted, kind }])
  return grantId
}

const DAY = 24 * 60 * 60 * 1000
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const THUMB = 'data:image/webp;base64,AAAA'

let dir: string
let logs: string[]
let now: number
const log = (level: string, message: string): void => {
  logs.push(`${level}: ${message}`)
}
const store = () => new Attachments({ userDataPath: dir, log, now: () => now })
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const image = (data = PNG, name = 'Image 1') => ({
  bytes: toArrayBuffer(data),
  mimeType: 'image/png',
  name,
})

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'overbench-attachments-'))
  logs = []
  now = 1_000 * DAY
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Attachments', () => {
  it('keeps a pasted image as a record and its bytes by hash', async () => {
    const attachments = store()
    await attachments.load()
    const added = await attachments.add(image(), THUMB)
    expect(added).toEqual({
      id: expect.any(String),
      type: 'image',
      name: 'Image 1',
      uri: null,
      mimeType: 'image/png',
      size: PNG.byteLength,
      sent: null,
      thumb: THUMB,
      blob: null,
    })
    const saved = path.join(dir, 'attachments', `${sha(PNG)}.png`)
    expect(new Uint8Array(await readFile(saved))).toEqual(PNG)
    const read = await attachments.read(added.id)
    expect(read.mimeType).toBe('image/png')
    expect(new Uint8Array(read.bytes)).toEqual(PNG)
    expect(attachments.view(added.id)).toEqual(added)

    await attachments.flush()
    const reopened = store()
    await reopened.load()
    expect(reopened.view(added.id)).toEqual(added)
  })

  it('takes only the image types every model takes', async () => {
    const attachments = store()
    await expect(
      attachments.add({ ...image(), mimeType: 'image/tiff' }, null),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(attachments.add({ ...image(), mimeType: 'text/plain' }, null)).rejects.toThrow()
  })

  it('answers not_found for an id it does not hold', async () => {
    const attachments = store()
    expect(() => attachments.get('nope')).toThrow(expect.objectContaining({ code: 'not_found' }))
    await expect(attachments.read('nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(attachments.remove('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('says which image is gone when its bytes are missing', async () => {
    const attachments = store()
    const added = await attachments.add(image(), null)
    await rm(path.join(dir, 'attachments', `${sha(PNG)}.png`))
    await expect(attachments.read(added.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(attachments.read(added.id)).rejects.toThrow(/Image 1/)
  })

  it('removes the bytes with the last record that holds them', async () => {
    const attachments = store()
    const first = await attachments.add(image(), null)
    const second = await attachments.add(image(PNG, 'Image 2'), null)
    expect(first.id).not.toBe(second.id)
    await attachments.remove(first.id)
    expect(await readdir(path.join(dir, 'attachments'))).toEqual([`${sha(PNG)}.png`])
    await attachments.remove(second.id)
    expect(await readdir(path.join(dir, 'attachments'))).toEqual([])
    expect(() => attachments.get(second.id)).toThrow()
  })

  it('links an agent to a copy of its own, which outlives the draft', async () => {
    const attachments = store()
    const first = await attachments.add(image(), null)
    const uri = await attachments.sentLink(attachments.get(first.id), PNG)
    const sent = path.join(dir, 'attachments', 'sent', `${sha(PNG)}.png`)
    expect(fileURLToPath(uri)).toBe(sent)
    await attachments.release([first.id])
    // The same image pasted again and removed takes only its own bytes.
    const again = await attachments.add(image(), null)
    await attachments.remove(again.id)
    expect(new Uint8Array(await readFile(sent))).toEqual(PNG)
    expect(await readdir(path.join(dir, 'attachments'))).toEqual(['sent'])
  })

  it('drops records older than 30 days, bytes no record holds and old sent copies', async () => {
    const attachments = store()
    const old = await attachments.add(image(), null)
    await attachments.sentLink(attachments.get(old.id), PNG)
    now += 2 * DAY
    const fresh = await attachments.add(image(new Uint8Array([9, 9]), 'Image 2'), null)
    await attachments.sentLink(attachments.get(fresh.id), new Uint8Array([9, 9]))
    await attachments.flush()
    // Left behind by a crash: no record holds it.
    await writeFile(path.join(dir, 'attachments', `${'b'.repeat(64)}.png`), 'orphan')

    now += ATTACHMENT_MAX_AGE_MS - DAY
    const reopened = store()
    await reopened.load()
    expect(() => reopened.get(old.id)).toThrow()
    expect(reopened.view(fresh.id).name).toBe('Image 2')
    const kept = `${sha(new Uint8Array([9, 9]))}.png`
    expect((await readdir(path.join(dir, 'attachments'))).sort()).toEqual([kept, 'sent'])
    expect(await readdir(path.join(dir, 'attachments', 'sent'))).toEqual([kept])
    await reopened.flush()
    const file = JSON.parse(await readFile(path.join(dir, 'state', 'attachments.json'), 'utf8'))
    expect(file.attachments.map((r: AttachmentRecord) => r.id)).toEqual([fresh.id])
  })

  it('keeps the records a draft names past 30 days from when they were added', async () => {
    const attachments = store()
    const named = await attachments.add(image(), null)
    const unnamed = await attachments.add(image(new Uint8Array([9, 9]), 'Image 2'), null)
    now += 20 * DAY
    expect(attachments.held([named.id, 'gone'])).toEqual([named.id])
    await attachments.flush()

    now += 20 * DAY
    const reopened = store()
    await reopened.load()
    expect(reopened.view(named.id).name).toBe('Image 1')
    expect(() => reopened.get(unnamed.id)).toThrow()
    expect(await readdir(path.join(dir, 'attachments'))).toEqual([`${sha(PNG)}.png`])
  })

  it('starts with no attachments folder', async () => {
    await mkdir(path.join(dir, 'state'), { recursive: true })
    const attachments = store()
    await expect(attachments.load()).resolves.toBeUndefined()
    expect(logs).toEqual([])
  })
})

describe('granted files and folders', () => {
  const PNG_FILE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
  let files: string

  beforeEach(async () => {
    files = await mkdtemp(path.join(tmpdir(), 'overbench-granted-'))
  })
  afterEach(async () => {
    await rm(files, { recursive: true, force: true })
  })

  it('adds a text file by its grant, reads nothing else, and keeps its path', async () => {
    const notes = path.join(files, 'notes.md')
    await writeFile(notes, '# Notes\n')
    const attachments = store()
    const added = await attachments.add({ grantId: grant(attachments, notes) }, null)
    expect(added).toEqual({
      id: expect.any(String),
      type: 'file',
      name: 'notes.md',
      uri: pathToFileURL(notes).href,
      mimeType: 'text/markdown',
      size: 8,
      sent: null,
      thumb: null,
      blob: null,
    })
    // Nothing is copied: the file is read again when it is sent.
    await expect(readdir(path.join(dir, 'attachments'))).rejects.toThrow()
    await attachments.flush()
    const reopened = store()
    await reopened.load()
    expect(reopened.view(added.id)).toEqual(added)
    expect(reopened.get(added.id).path).toBe(notes)
  })

  it('takes each grant once, and only one main gave', async () => {
    const notes = path.join(files, 'notes.md')
    await writeFile(notes, 'x')
    const attachments = store()
    const grantId = grant(attachments, notes)
    await attachments.add({ grantId }, null)
    await expect(attachments.add({ grantId }, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(attachments.add({ grantId: 'made-up' }, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })

  it('forgets a grant left unused for ten minutes', async () => {
    const notes = path.join(files, 'notes.md')
    await writeFile(notes, 'x')
    const attachments = store()
    const stale = grant(attachments, notes)
    const fresh = grant(attachments, notes)
    now += 10 * 60 * 1000 + 1
    await expect(attachments.add({ grantId: stale }, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    // A later grant still clears the old ones it finds.
    const later = grant(attachments, notes)
    await expect(attachments.add({ grantId: fresh }, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(attachments.add({ grantId: later }, null)).resolves.toMatchObject({
      name: 'notes.md',
    })
  })

  it('takes a grant used within ten minutes', async () => {
    const notes = path.join(files, 'notes.md')
    await writeFile(notes, 'x')
    const attachments = store()
    const fresh = grant(attachments, notes)
    now += 10 * 60 * 1000 - 1
    await expect(attachments.add({ grantId: 'unknown' }, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(attachments.add({ grantId: fresh }, null)).resolves.toMatchObject({
      name: 'notes.md',
    })
  })

  it('tells text from other files by their bytes, and names large ones by extension', async () => {
    const attachments = store()
    const add = async (name: string, data: string | Uint8Array) => {
      const file = path.join(files, name)
      await writeFile(file, data)
      return attachments.add({ grantId: grant(attachments, file) }, null)
    }
    expect((await add('Makefile', 'all:\n\ttrue\n')).mimeType).toBe('text/plain')
    expect((await add('data.json', new Uint8Array([0x7b, 0, 0x7d]))).mimeType).toBe(
      'application/octet-stream',
    )
    expect((await add('report.pdf', new Uint8Array([0x25, 0x50, 0xff, 0]))).mimeType).toBe(
      'application/pdf',
    )
    expect((await add('latin1.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).mimeType).toBe(
      'application/octet-stream',
    )
    const big = await add('big.log', 'x'.repeat(256 * 1024 + 1))
    expect(big).toMatchObject({ type: 'file', mimeType: 'text/plain', size: 256 * 1024 + 1 })
    // Named as a picture but not one: a file.
    expect(await add('fake.png', 'not a picture')).toMatchObject({ type: 'file' })
  })

  it('adds a folder as a link-only attachment', async () => {
    const src = path.join(files, 'src')
    await mkdir(src)
    const attachments = store()
    const added = await attachments.add({ grantId: grant(attachments, src, 'folder') }, null)
    expect(added).toMatchObject({ type: 'folder', name: 'src', size: null, mimeType: null })
    expect(added.uri).toBe(`${pathToFileURL(src).href}/`)
  })

  it('refuses a grant whose path is gone or is no longer what was granted', async () => {
    const notes = path.join(files, 'notes.md')
    await mkdir(notes)
    const attachments = store()
    await expect(attachments.add({ grantId: grant(attachments, notes) }, null)).rejects.toThrow(
      /notes\.md/,
    )
    await expect(
      attachments.add({ grantId: grant(attachments, path.join(files, 'gone')) }, null),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reads a picked image when it is added and keeps a copy, with the original as its URI', async () => {
    const shot = path.join(files, 'shot.png')
    await writeFile(shot, PNG_FILE)
    const attachments = store()
    const added = await attachments.add({ grantId: grant(attachments, shot) }, null)
    expect(added).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      size: PNG_FILE.byteLength,
      uri: pathToFileURL(shot).href,
      thumb: null,
    })
    // A change to the file after it was added is not what is sent.
    await writeFile(shot, 'changed')
    expect(new Uint8Array((await attachments.read(added.id)).bytes)).toEqual(PNG_FILE)
  })

  it('takes the thumbnail and the scaled copy the renderer made of an image', async () => {
    const shot = path.join(files, 'shot.png')
    await writeFile(shot, PNG_FILE)
    const attachments = store()
    const added = await attachments.add({ grantId: grant(attachments, shot) }, null)
    const withThumb = await attachments.update(added.id, THUMB, null)
    expect(withThumb).toEqual({ ...added, thumb: THUMB })

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 9])
    const scaled = await attachments.update(added.id, THUMB, {
      bytes: toArrayBuffer(jpeg),
      mimeType: 'image/jpeg',
    })
    expect(scaled).toMatchObject({ mimeType: 'image/jpeg', size: 4, uri: pathToFileURL(shot).href })
    expect(await readdir(path.join(dir, 'attachments'))).toEqual([`${sha(jpeg)}.jpg`])
    expect(new Uint8Array((await attachments.read(added.id)).bytes)).toEqual(jpeg)
  })

  it('updates only images, with the types a model takes', async () => {
    const notes = path.join(files, 'notes.md')
    await writeFile(notes, 'x')
    const attachments = store()
    const file = await attachments.add({ grantId: grant(attachments, notes) }, null)
    await expect(attachments.update(file.id, THUMB, null)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    const pasted = await attachments.add(image(), null)
    await expect(
      attachments.update(pasted.id, THUMB, { bytes: toArrayBuffer(PNG), mimeType: 'image/tiff' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(attachments.update('nope', THUMB, null)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('drops a scaled copy whose image was removed while it was written', async () => {
    const attachments = store()
    const pasted = await attachments.add(image(), null)
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 7])
    const updating = attachments.update(pasted.id, THUMB, {
      bytes: toArrayBuffer(jpeg),
      mimeType: 'image/jpeg',
    })
    await attachments.remove(pasted.id)
    await expect(updating).rejects.toMatchObject({ code: 'not_found' })
    expect(await readdir(path.join(dir, 'attachments'))).toEqual([])
  })
})

describe('parseAttachmentsFile', () => {
  const record: AttachmentRecord = {
    id: 'a1',
    type: 'image',
    name: 'Image 1',
    mimeType: 'image/png',
    size: 7,
    hash: 'c'.repeat(64),
    path: null,
    thumb: null,
    addedAt: 5,
  }

  it('keeps the records that parse and drops the rest', () => {
    expect(
      parseAttachmentsFile({
        attachments: [
          record,
          { ...record, id: 'a2', hash: '../escape' },
          { ...record, type: 'pdf' },
          { ...record, id: 'a3', heldAt: 9 },
          { ...record, id: 'a4', heldAt: 'later' },
        ],
      }),
    ).toEqual({ version: 1, attachments: [record, { ...record, id: 'a3', heldAt: 9 }] })
    expect(parseAttachmentsFile({ attachments: {} })).toBe('attachments is not a list')
  })

  it('reads an image stored before files could be attached, and checks each kind', () => {
    const older: Partial<AttachmentRecord> = { ...record }
    delete older.path
    const file = { ...record, id: 'f1', type: 'file', hash: null, path: '/p/a.md' }
    const folder = { ...file, id: 'd1', type: 'folder', size: null, mimeType: null }
    expect(
      parseAttachmentsFile({
        attachments: [
          older,
          file,
          folder,
          { ...file, id: 'f2', path: null },
          { ...file, id: 'f3', hash: 'c'.repeat(64) },
          { ...folder, id: 'd2', size: 4 },
          { ...record, id: 'a2', hash: null },
        ],
      }),
    ).toEqual({ version: 1, attachments: [record, file, folder] })
  })
})
