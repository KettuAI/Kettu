import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, UserContent } from '@shared/thread'
import { host } from '@renderer/lib/host'
import {
  draftAttachments,
  setDraftAttachments,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import {
  attachImages,
  attachmentContent,
  attachmentsBlock,
  pastedImages,
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
    const images = [item({ size: 3 * mb }), item({ size: 3 * mb })]
    expect(attachmentsBlock([...images, item({ size: 1.5 * mb })], '')).toBeNull()
    expect(attachmentsBlock([...images, item({ size: 1.6 * mb })], '')).toEqual({
      message: 'These attachments are over 10 MB in all. Remove some to send.',
      notice: true,
    })
    expect(attachmentsBlock(images, 'x'.repeat(2 * mb))).toBeNull()
    expect(attachmentsBlock(images, 'x'.repeat(2 * mb + 1))?.notice).toBe(true)
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
    restoreAttachments(DRAFT, [{ type: 'text', text: 'Look' }, ...content])
    const restored = draftAttachments(DRAFT)
    expect(restored.map((i) => [i.name, i.status, i.attachment?.id, i.size])).toEqual([
      ['Image 3', 'ready', undefined, 3],
      ['Image 1', 'ready', 'a1', 3],
      ['Image 2', 'ready', 'a2', 9],
    ])
    expect(new Set(restored.map((i) => i.key)).size).toBe(3)
  })
})
