import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearDraft,
  draftedSessions,
  flushDraft,
  parseDraft,
  readDraft,
  readDraftComments,
  writeDraft,
  writeDraftComments,
  type DraftComment,
} from './drafts'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size
  },
})

const comment = (id: string, entryId = 'e1'): DraftComment => ({
  id,
  entryId,
  passage: 'the passage',
  start: 4,
  end: 15,
  comment: `comment ${id}`,
})

beforeEach(() => {
  store.clear()
  for (const id of ['s1', 's2']) clearDraft(id)
})

describe('a draft with comments', () => {
  it('saves the comments with the text and loads them back', () => {
    writeDraft('s1', 'summary')
    writeDraftComments('s1', [comment('a'), comment('b', 'e2')])
    flushDraft('s1')
    const saved = JSON.parse(store.get('draft:s1')!) as Record<string, unknown>
    expect(saved.comments).toHaveLength(2)
    expect(readDraft('s1')).toBe('summary')
    expect(readDraftComments('s1')).toEqual([comment('a'), comment('b', 'e2')])
  })

  it('keeps a draft of comments alone, which counts as a draft', () => {
    writeDraftComments('s1', [comment('a')])
    flushDraft('s1')
    expect(store.has('draft:s1')).toBe(true)
    expect(draftedSessions()).toEqual(['s1'])
  })

  it('reads a draft saved before comments as one without them', () => {
    expect(parseDraft(JSON.stringify({ text: 'hi', attachments: [] })).comments).toEqual([])
    expect(parseDraft('plain text').comments).toEqual([])
  })

  it('drops a stored comment that is not one', () => {
    const raw = JSON.stringify({
      text: '',
      attachments: [],
      comments: [comment('a'), { id: 'b', entryId: 'e1', passage: 'p', start: '0' }, null],
    })
    expect(parseDraft(raw).comments).toEqual([comment('a')])
  })

  it('removes the stored draft once a send has taken the text and the comments', () => {
    writeDraft('s1', 'summary')
    writeDraftComments('s1', [comment('a')])
    flushDraft('s1')
    writeDraft('s1', '')
    writeDraftComments('s1', [])
    flushDraft('s1')
    expect(store.has('draft:s1')).toBe(false)
    expect(readDraftComments('s1')).toEqual([])
  })

  it('clears the comments with the draft', () => {
    writeDraftComments('s2', [comment('a')])
    flushDraft('s2')
    clearDraft('s2')
    expect(readDraftComments('s2')).toEqual([])
    expect(draftedSessions()).toEqual([])
  })
})
