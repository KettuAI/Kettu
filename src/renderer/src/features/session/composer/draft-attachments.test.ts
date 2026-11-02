import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@shared/thread'
import { host } from '@renderer/lib/host'
import {
  draftAttachments,
  patchDraftAttachment,
  setDraftAttachments,
} from '@renderer/stores/attachments'
import { attachImages, removeAttachment, restoreDraftAttachments } from './attachments'
import { flushDraft, NEW_SESSION_DRAFT, parseDraft, type SavedAttachment } from './drafts'
import { prepareImage } from './image-work'

vi.mock('./image-work', () => ({ prepareImage: vi.fn() }))
vi.mock('@renderer/lib/host', async (original) => ({
  ...(await original<typeof import('@renderer/lib/host')>()),
  host: vi.fn(),
}))

const request = vi.mocked(host)
const stored = new Map<string, string>()

const record = (id: string, name: string): Attachment => ({
  id,
  type: 'image',
  name,
  uri: null,
  mimeType: 'image/png',
  size: 3,
  sent: null,
  thumb: 'data:image/webp;base64,AAAA',
  blob: null,
})
const saved = (id: string, name: string): SavedAttachment => ({
  attachment: record(id, name),
  pixels: { width: 2400, height: 1500 },
  scaled: null,
})
let asked: string[] = []
const draftOf = (id: string) => parseDraft(stored.get(`draft:${id}`) ?? '')

// The restore runs once per launch, so these share the one it ran.
beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    get length() {
      return stored.size
    },
    key: (index: number) => [...stored.keys()][index] ?? null,
  })
  stored.set(
    'draft:s1',
    JSON.stringify({ text: 'Look', attachments: [saved('a1', 'Image 1'), saved('a2', 'Image 2')] }),
  )
  stored.set(
    `draft:${NEW_SESSION_DRAFT}`,
    JSON.stringify({ text: '', attachments: [saved('a3', 'Image 1')] }),
  )
  stored.set('draft:s2', 'Text alone')
  request.mockImplementation((async (method: string, params: { ids?: string[] }) => {
    if (method === 'attachments.held') {
      asked = params.ids!
      return asked.filter((id) => id !== 'a2')
    }
    if (method === 'attachments.add') return record('a9', 'Image 3')
    return undefined
  }) as typeof host)
  vi.mocked(prepareImage).mockResolvedValue({
    thumb: 'data:image/webp;base64,BBBB',
    width: 10,
    height: 10,
    bytes: new ArrayBuffer(3),
    mimeType: 'image/png',
    scaled: null,
    ms: 1,
  })
  await restoreDraftAttachments()
})
afterAll(() => {
  vi.unstubAllGlobals()
})

describe('restoreDraftAttachments', () => {
  it("puts each draft's attachments back, New session's too, and asks the host which it holds", () => {
    expect(asked).toEqual(['a3', 'a1', 'a2'])
    expect(draftAttachments(NEW_SESSION_DRAFT).map((i) => [i.name, i.status])).toEqual([
      ['Image 1', 'ready'],
    ])
    expect(draftAttachments('s1')[0]).toMatchObject({
      status: 'ready',
      attachment: record('a1', 'Image 1'),
      thumb: 'data:image/webp;base64,AAAA',
      pixels: { width: 2400, height: 1500 },
    })
    expect(draftAttachments('s2')).toEqual([])
  })

  it('fails one the host no longer holds as no longer available, and keeps it out of the draft', () => {
    expect(draftAttachments('s1')[1]).toMatchObject({
      name: 'Image 2',
      status: 'failed',
      attachment: null,
      gone: true,
    })
    flushDraft('s1')
    expect(draftOf('s1')).toEqual({ text: 'Look', attachments: [saved('a1', 'Image 1')] })
  })

  it('writes the draft once an attachment is added, not while it is being added', async () => {
    attachImages('s2', [new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })], null)
    flushDraft('s2')
    expect(stored.get('draft:s2')).toBe('Text alone')
    await vi.waitFor(() => expect(draftAttachments('s2')[0]?.status).toBe('ready'))
    flushDraft('s2')
    expect(draftOf('s2')).toEqual({
      text: 'Text alone',
      attachments: [
        { attachment: record('a9', 'Image 3'), pixels: { width: 10, height: 10 }, scaled: null },
      ],
    })
  })

  it('takes a removed attachment out of the draft, and the draft goes once it is empty', () => {
    const [item] = draftAttachments(NEW_SESSION_DRAFT)
    removeAttachment(NEW_SESSION_DRAFT, item!.key)
    flushDraft(NEW_SESSION_DRAFT)
    expect(stored.has(`draft:${NEW_SESSION_DRAFT}`)).toBe(false)
  })

  it('leaves the draft alone for a change that keeps the same added attachments', () => {
    const before = stored.get('draft:s1')
    const [item] = draftAttachments('s1')
    patchDraftAttachment('s1', item!.key, { error: null })
    setDraftAttachments('s1', [...draftAttachments('s1')])
    flushDraft('s1')
    expect(stored.get('draft:s1')).toBe(before)
  })
})
