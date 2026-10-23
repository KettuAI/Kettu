import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, UserContent } from '@shared/thread'
import { host } from '@renderer/lib/host'
import {
  draftAttachments,
  setDraftAttachments,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import type { GrantedAttachment } from '@shared/attachments'
import {
  attachFiles,
  attachImages,
  attachmentContent,
  attachmentsBlock,
  dropAttachments,
  pastedImages,
  pickAttachments,
  removeAttachment,
  restoreAttachments,
} from './attachments'
import { prepareImage, type PreparedImage } from './image-work'

vi.mock('./image-work', () => ({ prepareImage: vi.fn() }))
vi.mock('@renderer/lib/host', async (original) => ({
  ...(await original<typeof import('@renderer/lib/host')>()),
  host: vi.fn(),
}))

const prepare = vi.mocked(prepareImage)
const request = vi.mocked(host)
const DRAFT = 's1'

const png = (name = 'shot.png') =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
const prepared = (bytes = 3): PreparedImage => ({
  thumb: 'data:image/webp;base64,AAAA',
  width: 2400,
  height: 1500,
  bytes: new ArrayBuffer(bytes),
  mimeType: 'image/jpeg',
  scaled: { width: 2000, height: 1250 },
  ms: 4,
})
const record = (id: string, name: string, size = 3): Attachment => ({
  id,
  type: 'image',
  name,
  uri: null,
  mimeType: 'image/jpeg',
  size,
  sent: null,
  thumb: 'data:image/webp;base64,AAAA',
  blob: null,
})
const item = (changes: Partial<DraftAttachment>): DraftAttachment => ({
  key: 'k',
  name: 'Image 1',
  kind: 'image',
  status: 'ready',
  attachment: null,
  thumb: null,
  size: 3,
  pixels: null,
  scaled: null,
  error: null,
  ...changes,
})
const clipboard = (files: File[], text = '') =>
  ({
    files,
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  }) as unknown as DataTransfer
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

let added = 0
beforeEach(() => {
  added = 0
  prepare.mockImplementation(async () => prepared())
  request.mockImplementation((async (method: string, params: { source?: { name: string } }) => {
    if (method === 'attachments.add') return record(`a${++added}`, params.source!.name)
    return undefined
  }) as typeof host)
})
afterEach(() => {
  setDraftAttachments(DRAFT, [])
  vi.clearAllMocks()
})

describe('pastedImages', () => {
  it('takes the images a paste carries', () => {
    expect(pastedImages(clipboard([png(), new File(['x'], 'a.txt')]))).toHaveLength(1)
    expect(pastedImages(clipboard([]))).toEqual([])
    expect(pastedImages(clipboard([png()], 'https://example.com/shot.png'))).toHaveLength(1)
  })

  it('leaves a spreadsheet copy as text, though it carries a picture of the cells', () => {
    expect(pastedImages(clipboard([png()], 'a\tb\n1\t2'))).toEqual([])
    expect(pastedImages(clipboard([png()], 'first line\nsecond line'))).toEqual([])
  })
})

describe('attachImages', () => {
  it('names pasted images in order and adds them through the host', async () => {
    expect(attachImages(DRAFT, [png(), png()])).toBe(0)
    expect(draftAttachments(DRAFT).map((i) => [i.name, i.status])).toEqual([
      ['Image 1', 'adding'],
      ['Image 2', 'adding'],
    ])
    await settled()
    const [first] = draftAttachments(DRAFT)
    expect(first).toMatchObject({
      status: 'ready',
      attachment: { id: 'a1', name: 'Image 1' },
      thumb: 'data:image/webp;base64,AAAA',
      pixels: { width: 2400, height: 1500 },
      scaled: { width: 2000, height: 1250 },
    })
    expect(request).toHaveBeenCalledWith('attachments.add', {
      source: { bytes: expect.any(ArrayBuffer), mimeType: 'image/jpeg', name: 'Image 1' },
      thumb: 'data:image/webp;base64,AAAA',
    })

    // Numbering goes on after the highest, not the count.
    removeAttachment(DRAFT, first!.key)
    attachImages(DRAFT, [png()])
    expect(draftAttachments(DRAFT).map((i) => i.name)).toEqual(['Image 2', 'Image 3'])
    expect(request).toHaveBeenCalledWith('attachments.remove', { id: 'a1' })
  })

  it('adds no more than 20 and says how many did not fit', () => {
    expect(
      attachImages(
        DRAFT,
        Array.from({ length: 18 }, () => png()),
      ),
    ).toBe(0)
    expect(attachImages(DRAFT, [png(), png(), png(), png()])).toBe(2)
    expect(draftAttachments(DRAFT)).toHaveLength(20)
  })

  it('marks an image that cannot be read as failed, with the reason', async () => {
    prepare.mockRejectedValueOnce(new Error('The image could not be decoded'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    attachImages(DRAFT, [png()])
    await settled()
    expect(draftAttachments(DRAFT)[0]).toMatchObject({
      status: 'failed',
      error: 'The image could not be decoded',
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('removes the host record of an image removed while it was being added', async () => {
    attachImages(DRAFT, [png()])
    removeAttachment(DRAFT, draftAttachments(DRAFT)[0]!.key)
    await settled()
    expect(request).not.toHaveBeenCalledWith('attachments.add', expect.anything())

    let finish!: (value: Attachment) => void
    request.mockImplementationOnce(
      (() => new Promise<Attachment>((resolve) => (finish = resolve))) as typeof host,
    )
    attachImages(DRAFT, [png()])
    await settled()
    removeAttachment(DRAFT, draftAttachments(DRAFT)[0]!.key)
    finish(record('late', 'Image 1'))
    await settled()
    expect(request).toHaveBeenCalledWith('attachments.remove', { id: 'late' })
    expect(draftAttachments(DRAFT)).toEqual([])
  })
})

describe('attachmentsBlock', () => {
  it('holds a message back until every attachment is added', () => {
    expect(attachmentsBlock([], 'hi')).toBeNull()
    expect(attachmentsBlock([item({ status: 'ready' })], 'hi')).toBeNull()
    expect(attachmentsBlock([item({ status: 'adding' })], '')).toEqual({
      message: 'Adding…',
      notice: false,
    })
    expect(attachmentsBlock([item({ status: 'adding' }), item({ status: 'failed' })], '')).toEqual({
      message: 'Remove the attachments that could not be added',
      notice: false,
    })
  })

  it('refuses more than 10 MB in all, counted in base64 as the host counts it', () => {
    const mb = 1024 * 1024
    // 3 MB is 4 MB in base64.
    const image = (size: number) => item({ size, attachment: record('i', 'Image', size) })
    const images = [image(3 * mb), image(3 * mb)]
    expect(attachmentsBlock([...images, image(1.5 * mb)], '')).toBeNull()
    expect(attachmentsBlock([...images, image(1.6 * mb)], '')).toEqual({
      message: 'These attachments are over 10 MB in all. Remove some to send.',
      notice: true,
    })
    expect(attachmentsBlock(images, 'x'.repeat(2 * mb))).toBeNull()
    expect(attachmentsBlock(images, 'x'.repeat(2 * mb + 1))?.notice).toBe(true)
  })

  it('counts a text file sent with its contents, and nothing for a link', () => {
    const mb = 1024 * 1024
    const file = (mimeType: string, size: number) =>
      item({
        kind: 'file',
        size,
        attachment: { ...record('f', 'a'), type: 'file', mimeType, size },
      })
    const images = [item({ size: 3 * mb, attachment: record('i', 'Image', 3 * mb) })]
    // 8 MB of images, then 20 kB of text tips it over; a 2 MB PDF goes as a link and does not.
    const full = [...images, ...images]
    expect(
      attachmentsBlock([...full, file('application/pdf', 2 * mb)], 'x'.repeat(2 * mb - 10)),
    ).toBeNull()
    expect(
      attachmentsBlock([...full, file('text/markdown', 20_000)], 'x'.repeat(2 * mb - 10))?.notice,
    ).toBe(true)
  })
})

describe('picked and dropped files', () => {
  const pick = vi.fn<(kind: string, folder: string | null) => Promise<GrantedAttachment[]>>()
  const fromFiles = vi.fn<(files: File[]) => Promise<(GrantedAttachment | null)[]>>()
  const grant = (name: string, kind: 'file' | 'folder' = 'file', size: number | null = 8) => ({
    grantId: `g-${name}`,
    name,
    kind,
    size,
  })
  const hostRecord = (name: string, type: Attachment['type'], changes: Partial<Attachment> = {}) =>
    ({
      ...record(`r-${name}`, name, 8),
      type,
      uri: `file:///p/${name}`,
      mimeType: type === 'image' ? 'image/png' : 'text/markdown',
      thumb: null,
      ...changes,
    }) satisfies Attachment

  beforeEach(() => {
    vi.stubGlobal('window', { overbench: { attachments: { pick, fromFiles } } })
    request.mockImplementation((async (method: string, params: Record<string, unknown>) => {
      const source = params.source as { grantId: string } | undefined
      if (method === 'attachments.add') {
        const name = source!.grantId.slice(2)
        return hostRecord(name, /\.png$/.test(name) ? 'image' : name === 'src' ? 'folder' : 'file')
      }
      if (method === 'attachments.read') return { mimeType: 'image/png', bytes: new ArrayBuffer(8) }
      if (method === 'attachments.update') {
        const scaled = params.scaled as { bytes: ArrayBuffer; mimeType: string } | null
        return hostRecord('shot.png', 'image', {
          thumb: params.thumb as string,
          ...(scaled ? { mimeType: scaled.mimeType, size: scaled.bytes.byteLength } : {}),
        })
      }
      return undefined
    }) as typeof host)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds what the dialog granted, opening it in the session folder', async () => {
    pick.mockResolvedValue([grant('notes.md'), grant('src', 'folder', null)])
    await expect(pickAttachments(DRAFT, 'files', '/p')).resolves.toBe(0)
    expect(pick).toHaveBeenCalledWith('files', '/p')
    await settled()
    expect(draftAttachments(DRAFT).map((i) => [i.kind, i.status, i.attachment?.uri])).toEqual([
      ['file', 'ready', 'file:///p/notes.md'],
      ['folder', 'ready', 'file:///p/src'],
    ])
    expect(request).toHaveBeenCalledWith('attachments.add', {
      source: { grantId: 'g-notes.md' },
      thumb: null,
    })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('makes a picked image its thumbnail from the bytes the host read, and hands back a scaled copy', async () => {
    pick.mockResolvedValue([grant('shot.png')])
    await pickAttachments(DRAFT, 'files', '/p')
    await vi.waitFor(() => expect(draftAttachments(DRAFT)[0]?.status).toBe('ready'))
    expect(request).toHaveBeenCalledWith('attachments.read', { id: 'r-shot.png' })
    expect(request).toHaveBeenCalledWith('attachments.update', {
      id: 'r-shot.png',
      thumb: 'data:image/webp;base64,AAAA',
      scaled: { bytes: expect.any(ArrayBuffer), mimeType: 'image/jpeg' },
    })
    expect(draftAttachments(DRAFT)[0]).toMatchObject({
      kind: 'image',
      thumb: 'data:image/webp;base64,AAAA',
      scaled: { width: 2000, height: 1250 },
      attachment: { mimeType: 'image/jpeg', size: 3 },
    })
  })

  it('keeps an image that fits as it is, sending only its thumbnail', async () => {
    prepare.mockImplementation(async () => ({
      ...prepared(8),
      mimeType: 'image/png',
      scaled: null,
    }))
    pick.mockResolvedValue([grant('shot.png')])
    await pickAttachments(DRAFT, 'files', '/p')
    await vi.waitFor(() => expect(draftAttachments(DRAFT)[0]?.status).toBe('ready'))
    expect(request).toHaveBeenCalledWith('attachments.update', {
      id: 'r-shot.png',
      thumb: 'data:image/webp;base64,AAAA',
      scaled: null,
    })
  })

  it('makes a dropped image its thumbnail from the File, not from the host', async () => {
    const file = png('shot.png')
    fromFiles.mockResolvedValue([grant('shot.png')])
    await attachFiles(DRAFT, [file])
    await vi.waitFor(() => expect(draftAttachments(DRAFT)[0]?.status).toBe('ready'))
    expect(prepare).toHaveBeenCalledWith(file)
    expect(request).not.toHaveBeenCalledWith('attachments.read', expect.anything())
  })

  it('shows dropped files at once, and fails one with nothing on disk behind it', async () => {
    fromFiles.mockResolvedValue([grant('notes.md'), null])
    const adding = attachFiles(DRAFT, [new File(['# x'], 'notes.md'), new File(['x'], 'blob')])
    expect(draftAttachments(DRAFT).map((i) => [i.name, i.status])).toEqual([
      ['notes.md', 'adding'],
      ['blob', 'adding'],
    ])
    await adding
    await settled()
    expect(draftAttachments(DRAFT).map((i) => i.status)).toEqual(['ready', 'failed'])
  })

  it('grants no more than fit, and says how many did not', async () => {
    attachImages(
      DRAFT,
      Array.from({ length: 19 }, () => png()),
    )
    fromFiles.mockResolvedValue([grant('a.md')])
    const files = [new File(['a'], 'a.md'), new File(['b'], 'b.md'), new File(['c'], 'c.md')]
    await expect(attachFiles(DRAFT, files)).resolves.toBe(2)
    expect(fromFiles).toHaveBeenCalledWith([files[0]])
    expect(draftAttachments(DRAFT)).toHaveLength(20)
    pick.mockResolvedValue([grant('x.md'), grant('y.md')])
    await expect(pickAttachments(DRAFT, 'files', null)).resolves.toBe(2)
  })

  it('fails the tiles when main cannot grant them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fromFiles.mockRejectedValue(new Error("The agent host isn't running."))
    await attachFiles(DRAFT, [new File(['a'], 'a.md')])
    expect(draftAttachments(DRAFT)[0]).toMatchObject({
      status: 'failed',
      error: "The agent host isn't running.",
    })
  })

  it('removes the record of a file removed while it was being added', async () => {
    pick.mockResolvedValue([grant('notes.md')])
    await pickAttachments(DRAFT, 'files', '/p')
    removeAttachment(DRAFT, draftAttachments(DRAFT)[0]!.key)
    await settled()
    expect(request).toHaveBeenCalledWith('attachments.remove', { id: 'r-notes.md' })
    expect(draftAttachments(DRAFT)).toEqual([])
  })
})

describe('attachmentContent and restoreAttachments', () => {
  it('names only added attachments, and puts a queued message back as it was', () => {
    const one = record('a1', 'Image 1')
    const two = record('a2', 'Image 2', 9)
    const content = attachmentContent([
      item({ attachment: one }),
      item({ status: 'adding' }),
      item({ attachment: two }),
    ])
    expect(content).toEqual<UserContent[]>([
      { type: 'ref', ref: { kind: 'attachment', attachment: one } },
      { type: 'ref', ref: { kind: 'attachment', attachment: two } },
    ])

    setDraftAttachments(DRAFT, [item({ key: 'held', name: 'Image 3' })])
    expect(restoreAttachments(DRAFT, [{ type: 'text', text: 'Look' }, ...content])).toBe(0)
    const restored = draftAttachments(DRAFT)
    expect(restored.map((i) => [i.name, i.status, i.attachment?.id, i.size])).toEqual([
      ['Image 3', 'ready', undefined, 3],
      ['Image 1', 'ready', 'a1', 3],
      ['Image 2', 'ready', 'a2', 9],
    ])
    expect(new Set(restored.map((i) => i.key)).size).toBe(3)
  })

  it('puts back only what fits under 20 and removes the records of the rest', () => {
    setDraftAttachments(
      DRAFT,
      Array.from({ length: 18 }, (_, i) => item({ key: `k${i}` })),
    )
    const queued = attachmentContent(
      ['q1', 'q2', 'q3'].map((id) => item({ attachment: record(id, id) })),
    )
    expect(restoreAttachments(DRAFT, queued)).toBe(1)
    expect(draftAttachments(DRAFT)).toHaveLength(20)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('attachments.remove', { id: 'q3' })
  })
})

describe('dropAttachments', () => {
  it('drops the attachments of a deleted session with their records', () => {
    setDraftAttachments(DRAFT, [
      item({ key: 'a', attachment: record('a1', 'Image 1') }),
      item({ key: 'b', status: 'adding' }),
    ])
    dropAttachments(DRAFT)
    expect(draftAttachments(DRAFT)).toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('attachments.remove', { id: 'a1' })
  })
})
