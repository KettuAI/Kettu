import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@shared/thread'
import {
  clearDraft,
  draftedSessions,
  draftIds,
  flushDraft,
  NEW_SESSION_DRAFT,
  parseDraft,
  readDraft,
  readDraftAttachments,
  writeDraft,
  writeDraftAttachments,
  type SavedAttachment,
} from './drafts'

const attachment: Attachment = {
  id: 'a1',
  type: 'image',
  name: 'Image 1',
  uri: null,
  mimeType: 'image/png',
  size: 3,
  sent: null,
  thumb: 'data:image/webp;base64,AAAA',
  blob: null,
}
const saved: SavedAttachment = {
  attachment,
  pixels: { width: 2400, height: 1500 },
  scaled: { width: 2000, height: 1250 },
}

class MemoryStorage {
  items = new Map<string, string>()
  failWrites = false
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  get length() {
    return this.items.size
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('drafts', () => {
  it('writes 300 ms after the last keystroke', () => {
    writeDraft('s1', 'h')
    writeDraft('s1', 'he')
    vi.advanceTimersByTime(299)
    expect(storage.getItem('draft:s1')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(parseDraft(storage.getItem('draft:s1')!)).toEqual({ text: 'he', attachments: [] })
  })

  it('reads the unsaved text before it is written', () => {
    writeDraft('s2', 'pending')
    expect(readDraft('s2')).toBe('pending')
  })

  it('removes the draft when the text is emptied or the prompt is sent', () => {
    storage.setItem('draft:s3', 'old')
    writeDraft('s3', '')
    flushDraft('s3')
    expect(storage.getItem('draft:s3')).toBeNull()
    storage.setItem('draft:s4', 'old')
    clearDraft('s4')
    expect(readDraft('s4')).toBe('')
  })

  it('keeps a draft in memory when the write fails', () => {
    storage.failWrites = true
    writeDraft('s5', 'kept')
    flushDraft('s5')
    expect(storage.getItem('draft:s5')).toBeNull()
    expect(readDraft('s5')).toBe('kept')
    expect(console.warn).toHaveBeenCalled()
  })
})

describe('drafts with attachments', () => {
  it('stores text and attachments as JSON, text alone too', () => {
    writeDraft('t1', 'Look at this')
    writeDraftAttachments('t1', [saved])
    vi.advanceTimersByTime(300)
    expect(JSON.parse(storage.getItem('draft:t1')!)).toEqual({
      text: 'Look at this',
      attachments: [saved],
    })
    writeDraftAttachments('t1', [])
    vi.advanceTimersByTime(300)
    expect(JSON.parse(storage.getItem('draft:t1')!)).toEqual({
      text: 'Look at this',
      attachments: [],
    })
  })

  it('reads both back after a restart, and keeps one when the other changes', () => {
    storage.setItem('draft:t2', JSON.stringify({ text: 'Before', attachments: [saved] }))
    expect(readDraft('t2')).toBe('Before')
    expect(readDraftAttachments('t2')).toEqual([saved])
    writeDraft('t2', 'After')
    expect(readDraftAttachments('t2')).toEqual([saved])
    writeDraftAttachments('t2', [])
    expect(readDraft('t2')).toBe('After')
  })

  it('keeps a draft of attachments alone, and removes it once both are empty', () => {
    writeDraftAttachments('t3', [saved])
    flushDraft('t3')
    expect(parseDraft(storage.getItem('draft:t3')!)).toEqual({ text: '', attachments: [saved] })
    writeDraftAttachments('t3', [])
    flushDraft('t3')
    expect(storage.getItem('draft:t3')).toBeNull()
  })

  it('keeps typed text that looks like a stored draft as it was typed', () => {
    const typed = JSON.stringify({ text: 'x', attachments: [] })
    writeDraft('t5', typed)
    flushDraft('t5')
    expect(parseDraft(storage.getItem('draft:t5')!).text).toBe(typed)
  })

  it('reads text that only looks like JSON as text, and drops attachments that do not parse', () => {
    expect(parseDraft('{ "a": 1 }')).toEqual({ text: '{ "a": 1 }', attachments: [] })
    expect(parseDraft('{not json')).toEqual({ text: '{not json', attachments: [] })
    expect(parseDraft('{"text":"x"}')).toEqual({ text: '{"text":"x"}', attachments: [] })
    const stored = {
      text: 'x',
      attachments: [saved, { attachment: { id: 1 } }, { ...saved, pixels: 4 }],
    }
    expect(parseDraft(JSON.stringify(stored))).toEqual({ text: 'x', attachments: [saved] })
  })

  it('lists every draft, New session included', () => {
    storage.setItem('draft:new', 'Something to start')
    storage.setItem('view:v1', '{}')
    writeDraft('t4', 'typing')
    expect(draftIds()).toEqual(expect.arrayContaining(['new', 't4']))
    expect(draftIds()).not.toContain('v1')
  })
})

describe('draftedSessions', () => {
  // Drafts the tests above left in memory.
  beforeEach(() => {
    for (const id of draftedSessions()) clearDraft(id)
  })

  it('lists the sessions whose saved or unsaved draft is more than white space', () => {
    storage.setItem('draft:saved', 'Fix the build')
    storage.setItem('draft:blank', '  \n\t')
    storage.setItem('draft:new', 'A session still to start')
    storage.setItem('view:v1', '{}')
    writeDraft('typing', 'Half a thought')
    writeDraft('spaces', '   ')
    writeDraft(NEW_SESSION_DRAFT, 'Another')
    expect(draftedSessions()).toEqual(['saved', 'typing'])
  })

  it('counts a draft of attachments alone', () => {
    storage.setItem('draft:held', JSON.stringify({ text: ' ', attachments: [saved] }))
    writeDraftAttachments('typing', [saved])
    writeDraftAttachments(NEW_SESSION_DRAFT, [saved])
    expect(draftedSessions()).toEqual(['held', 'typing'])
  })

  it('takes the text being typed over the one saved before', () => {
    storage.setItem('draft:saved', 'Fix the build')
    writeDraft('saved', '')
    expect(draftedSessions()).toEqual([])
  })
})
