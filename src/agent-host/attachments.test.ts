import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_MAX_AGE_MS,
  Attachments,
  parseAttachmentsFile,
  toArrayBuffer,
  type AttachmentRecord,
} from './attachments'

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
    expect(fileURLToPath(attachments.fileUri(attachments.get(added.id)))).toBe(saved)
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

  it('keeps the bytes a link sent to an agent points to', async () => {
    const attachments = store()
    const added = await attachments.add(image(), null)
    await attachments.release([added.id], new Set([sha(PNG)]))
    expect(() => attachments.get(added.id)).toThrow()
    expect(await readdir(path.join(dir, 'attachments'))).toEqual([`${sha(PNG)}.png`])
  })

  it('drops records and unneeded bytes older than 30 days when it starts', async () => {
    const attachments = store()
    const old = await attachments.add(image(), null)
    now += 2 * DAY
    const fresh = await attachments.add(image(new Uint8Array([9, 9]), 'Image 2'), null)
    await attachments.flush()

    // Bytes a sent link points to: no record, so only their age keeps them.
    const linked = path.join(dir, 'attachments', 'a'.repeat(64))
    const stale = path.join(dir, 'attachments', 'b'.repeat(64))
    await writeFile(linked, 'linked')
    await writeFile(stale, 'stale')
    const past = new Date(now - ATTACHMENT_MAX_AGE_MS - DAY)
    await utimes(stale, past, past)

    now += ATTACHMENT_MAX_AGE_MS - DAY
    const reopened = store()
    await reopened.load()
    expect(() => reopened.get(old.id)).toThrow()
    expect(reopened.view(fresh.id).name).toBe('Image 2')
    expect((await readdir(path.join(dir, 'attachments'))).sort()).toEqual(
      [`${sha(PNG)}.png`, `${sha(new Uint8Array([9, 9]))}.png`, 'a'.repeat(64)].sort(),
    )
    await reopened.flush()
    const file = JSON.parse(await readFile(path.join(dir, 'state', 'attachments.json'), 'utf8'))
    expect(file.attachments.map((r: AttachmentRecord) => r.id)).toEqual([fresh.id])
  })

  it('starts with no attachments folder', async () => {
    await mkdir(path.join(dir, 'state'), { recursive: true })
    const attachments = store()
    await expect(attachments.load()).resolves.toBeUndefined()
    expect(logs).toEqual([])
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
        ],
      }),
    ).toEqual({ version: 1, attachments: [record] })
    expect(parseAttachmentsFile({ attachments: {} })).toBe('attachments is not a list')
  })
})
