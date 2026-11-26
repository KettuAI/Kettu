import { describe, expect, it } from 'vitest'
import { isPending, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { DOCUMENT_ENTRY } from '@shared/artifact-document-anchors'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import {
  canInlineDeckThread,
  canInlineDocThread,
  rowSendKind,
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
