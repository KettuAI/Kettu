import { create } from 'zustand'
import type { Attachment } from '@shared/thread'

/** An attachment while a composer holds it: being added, added, or failed. */
export interface DraftAttachment {
  /** The composer's own key, stable while the host's record is still being made. */
  key: string
  name: string
  /** What it is, known before the host's record is: from the paste, the grant or the name. */
  kind: Attachment['type']
  status: 'adding' | 'ready' | 'failed'
  /** The host's record, once added. */
  attachment: Attachment | null
  thumb: string | null
  /** What is sent, in bytes. */
  size: number | null
  /** The image's own pixel size, and the size it is scaled to when it is too large. */
  pixels: { width: number; height: number } | null
  scaled: { width: number; height: number } | null
  error: string | null
}

interface AttachmentsStore {
  /** By draft: a session's id, or New session's draft key. */
  byDraft: Record<string, DraftAttachment[]>
}

export const useAttachmentsStore = create<AttachmentsStore>()(() => ({ byDraft: {} }))

const EMPTY: DraftAttachment[] = []

export function draftAttachments(draft: string): DraftAttachment[] {
  return useAttachmentsStore.getState().byDraft[draft] ?? EMPTY
}

/** A composer's attachments, for a selector; the same empty list when it has none. */
export function selectDraft(draft: string) {
  return (s: AttachmentsStore): DraftAttachment[] => s.byDraft[draft] ?? EMPTY
}

export function setDraftAttachments(draft: string, items: DraftAttachment[]): void {
  useAttachmentsStore.setState((s) => {
    const byDraft = { ...s.byDraft }
    if (items.length > 0) byDraft[draft] = items
    else delete byDraft[draft]
    return { byDraft }
  })
}

export function patchDraftAttachment(
  draft: string,
  key: string,
  changes: Partial<DraftAttachment>,
): void {
  const items = draftAttachments(draft)
  if (!items.some((item) => item.key === key)) return
  setDraftAttachments(
    draft,
    items.map((item) => (item.key === key ? { ...item, ...changes } : item)),
  )
}
