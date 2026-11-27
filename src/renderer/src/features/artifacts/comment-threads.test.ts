import { describe, expect, it } from 'vitest'
import { isPending, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { DOCUMENT_ENTRY } from '@shared/artifact-document-anchors'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import enArtifacts from '@shared/locales/en/artifacts.json'
import zhArtifacts from '@shared/locales/zh-CN/artifacts.json'
import {
  canInlineDeckThread,
  canInlineDocThread,
  matchingOpenThread,
  rowSendKind,
  threadNumbers,
  threadRowMenuKinds,
  threadState,
} from './comment-threads'

function anchor(patch: Partial<CommentAnchor> = {}): CommentAnchor {
  return {
    version: 1,
    path: ARTIFACT_ENTRY,
    page: null,
    offset: 14,
    tag: 'p',
    text: 'Body',
    missing: false,
    ...patch,
  }
}

function thread(patch: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D3',
    anchor: anchor(),
    comments: [{ author: { person: 'owner', session: null }, createdAt: 1, body: 'Fix this' }],
    resolvedAt: null,
    sentAt: null,
    sentTo: null,
    ...patch,
  }
}

describe('reopened and missing-anchor comment threads', () => {
  it('treats a reopened thread with a missing anchor as pending and sendable', () => {
    const reopenedMissing = thread({
      anchor: anchor({ missing: true }),
      resolvedAt: null,
      sentAt: null,
      sentTo: null,
    })
    expect(isPending(reopenedMissing)).toBe(true)
    expect(threadState(reopenedMissing, null)).toEqual({ kind: 'gone' })
    expect(rowSendKind(reopenedMissing, 'open')).toBe('sendOnly')
  })

  it('offers Send again on already-sent open threads so legacy reopened threads are never locked', () => {
    const sentOpen = thread({
      anchor: anchor({ missing: true }),
      resolvedAt: null,
      sentAt: 10,
      sentTo: 'session-1',
    })
    expect(isPending(sentOpen)).toBe(false)
    expect(rowSendKind(sentOpen, 'open')).toBe('sendAgain')
    expect(rowSendKind(sentOpen, 'resolved')).toBeNull()
  })

  it('offers no send action on resolved threads', () => {
    const resolved = thread({ resolvedAt: 20, sentAt: 10, sentTo: 'session-1' })
    expect(rowSendKind(resolved, 'open')).toBeNull()
    expect(rowSendKind(resolved, 'resolved')).toBeNull()
  })
})

describe('canInlineDocThread', () => {
  const openDoc = { latest: true, commentsOpen: true }

  it('allows inline opening only for open, anchored document block threads on the latest version', () => {
    expect(
      canInlineDocThread(
        thread({ anchor: anchor({ path: DOCUMENT_ENTRY, offset: 12, missing: false }) }),
        openDoc,
      ),
    ).toBe(true)
  })

  it('falls back to the popover when the anchor is missing, page-level, resolved, or not latest', () => {
    expect(
      canInlineDocThread(
        thread({ anchor: anchor({ path: DOCUMENT_ENTRY, offset: 12, missing: true }) }),
        openDoc,
      ),
    ).toBe(false)
    expect(
      canInlineDocThread(
        thread({ anchor: anchor({ path: DOCUMENT_ENTRY, offset: null, missing: false }) }),
        openDoc,
      ),
    ).toBe(false)
    expect(
      canInlineDocThread(
        thread({ anchor: anchor({ path: ARTIFACT_ENTRY, offset: 12, missing: false }) }),
        openDoc,
      ),
    ).toBe(false)
    expect(
      canInlineDocThread(
        thread({
          anchor: anchor({ path: DOCUMENT_ENTRY, offset: 12, missing: false }),
          resolvedAt: 10,
        }),
        openDoc,
      ),
    ).toBe(false)
    expect(
      canInlineDocThread(
        thread({ anchor: anchor({ path: DOCUMENT_ENTRY, offset: 12, missing: false }) }),
        { latest: false, commentsOpen: true },
      ),
    ).toBe(false)
  })
})

describe('canInlineDeckThread', () => {
  const openDeck = { latest: true, commentsOpen: true, slideCount: 3 }

  it('allows inline opening for open threads targeting an existing slide', () => {
    expect(
      canInlineDeckThread(
        thread({
          anchor: anchor({
            path: ARTIFACT_ENTRY,
            page: { number: 2, name: 'Results' },
            missing: true,
          }),
        }),
        openDeck,
      ),
    ).toBe(true)
  })

  it('falls back to the popover for resolved threads or threads without a valid slide', () => {
    expect(
      canInlineDeckThread(
        thread({
          anchor: anchor({ path: ARTIFACT_ENTRY, page: { number: 2, name: 'Results' } }),
          resolvedAt: 5,
        }),
        openDeck,
      ),
    ).toBe(false)
    expect(
      canInlineDeckThread(
        thread({ anchor: anchor({ path: ARTIFACT_ENTRY, page: null }) }),
        openDeck,
      ),
    ).toBe(false)
    expect(
      canInlineDeckThread(
        thread({ anchor: anchor({ path: ARTIFACT_ENTRY, page: { number: 5, name: null } }) }),
        openDeck,
      ),
    ).toBe(false)
  })
})

describe('matchingOpenThread', () => {
  const T1 = 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D1'
  const T2 = 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D2'
  const T3 = 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'

  it('reuses an existing open thread on the same source element and keeps distinct child elements separate', () => {
    const parent = anchor({ path: ARTIFACT_ENTRY, offset: 14, tag: 'div', text: 'Card' })
    const child = anchor({ path: ARTIFACT_ENTRY, offset: 28, tag: 'p', text: 'Subtitle' })
    const threads = [
      thread({ id: T1, anchor: parent }),
      thread({ id: T2, anchor: parent }),
      thread({ id: T3, anchor: parent, resolvedAt: 99 }),
    ]

    // Returns the latest open match by default, or the preferred match when specified.
    expect(matchingOpenThread(threads, parent)?.id).toBe(T2)
    expect(matchingOpenThread(threads, parent, T1)?.id).toBe(T1)
    // A child element with a different source offset starts a new draft instead of reusing parent.
    expect(matchingOpenThread(threads, child)).toBeNull()
    // Resolved or missing-anchor threads are never reused.
    expect(
      matchingOpenThread(
        [
          thread({ id: T3, anchor: parent, resolvedAt: 99 }),
          thread({ id: T1, anchor: { ...parent, missing: true } }),
        ],
        parent,
      ),
    ).toBeNull()
  })

  it('matches document blocks by offset and slide/scripted elements by page, tag and text', () => {
    const docBlock = anchor({ path: DOCUMENT_ENTRY, offset: 42, tag: 'p', text: 'Intro' })
    const slideItem = anchor({
      path: ARTIFACT_ENTRY,
      page: { number: 2, name: 'Metrics' },
      offset: null,
      tag: 'h2',
      text: 'Revenue',
    })
    const threads = [thread({ id: T1, anchor: docBlock }), thread({ id: T2, anchor: slideItem })]

    expect(matchingOpenThread(threads, docBlock)?.id).toBe(T1)
    expect(matchingOpenThread(threads, { ...docBlock, offset: 88 })).toBeNull()

    expect(matchingOpenThread(threads, slideItem)?.id).toBe(T2)
    expect(matchingOpenThread(threads, { ...slideItem, text: 'Cost' })).toBeNull()
    expect(
      matchingOpenThread(threads, { ...slideItem, page: { number: 3, name: 'Next' } }),
    ).toBeNull()
  })
})

describe('threadRowMenuKinds and pin renumbering', () => {
  it('offers locate, send, mark resolved and delete for open rows', () => {
    const unsent = thread({ resolvedAt: null, sentAt: null })
    expect(threadRowMenuKinds(unsent, 'open', { canResolve: true, canDelete: true })).toEqual([
      'locate',
      'sendOnly',
      'resolve',
      'delete',
    ])

    const sent = thread({ resolvedAt: null, sentAt: 10, sentTo: 's1' })
    expect(threadRowMenuKinds(sent, 'open', { canResolve: true, canDelete: true })).toEqual([
      'locate',
      'sendAgain',
      'resolve',
      'delete',
    ])

    const gone = thread({ anchor: anchor({ missing: true }), resolvedAt: null, sentAt: null })
    expect(threadRowMenuKinds(gone, 'open', { canResolve: true, canDelete: false })).toEqual([
      'view',
      'sendOnly',
      'resolve',
    ])
  })

  it('offers locate/view, reopen and delete for resolved rows without send actions', () => {
    const resolved = thread({ resolvedAt: 20, sentAt: 10, sentTo: 's1' })
    expect(threadRowMenuKinds(resolved, 'resolved', { canResolve: true, canDelete: true })).toEqual(
      ['locate', 'reopen', 'delete'],
    )
    expect(
      threadRowMenuKinds(resolved, 'resolved', { canResolve: false, canDelete: false }),
    ).toEqual(['locate'])
  })

  it('renumbers remaining threads sequentially after one is deleted', () => {
    const t1 = thread({ id: 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D1' })
    const t2 = thread({ id: 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D2' })
    const t3 = thread({ id: 'thr_01J9Z3K4V5W6X7Y8Z9A0B1C2D3' })
    expect([...threadNumbers([t1, t2, t3]).entries()]).toEqual([
      [t1.id, 1],
      [t2.id, 2],
      [t3.id, 3],
    ])
    expect([...threadNumbers([t2, t3]).entries()]).toEqual([
      [t2.id, 1],
      [t3.id, 2],
    ])
  })
})

describe('artifact comments bilingual locales', () => {
  const keys = [
    'newThread',
    'locate',
    'viewThread',
    'delete',
    'deleteTitle',
    'deleteTitleReplies',
    'deleteDescription',
    'deleteDescriptionReplies',
    'deleteConfirm',
    'deleting',
    'deleteFailed',
    'resolveFailed',
  ] as const

  it('keeps English and Simplified Chinese keys present with matching placeholders', () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    for (const key of keys) {
      const en = enArtifacts.comments[key]
      const zh = zhArtifacts.comments[key]
      expect(typeof en).toBe('string')
      expect(typeof zh).toBe('string')
      expect(en.trim().length).toBeGreaterThan(0)
      expect(zh.trim().length).toBeGreaterThan(0)
      expect(placeholders(zh)).toEqual(placeholders(en))
    }
  })
})
