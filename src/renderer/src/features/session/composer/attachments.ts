// A composer's attachments: adding pasted images through the host, removing them, and the content
// refs a message carries. See docs/design/ui.md#attachments.

import { ATTACHMENT_LIMIT, PROMPT_BYTES, sentBytes } from '@shared/attachments'
import type { UserContent } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import {
  draftAttachments,
  patchDraftAttachment,
  setDraftAttachments,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import { prepareImage } from './image-work'

let nextKey = 1

/** The images a paste carries, unless it is table or multi-line text that also has a picture. */
export function pastedImages(data: DataTransfer): File[] {
  const images = [...data.files].filter((file) => file.type.startsWith('image/'))
  if (images.length === 0) return []
  // A spreadsheet's copy holds its cells as text and a picture of them; the text is what is meant.
  const text = data.getData('text/plain')
  return /[\t\n]/.test(text) ? [] : images
}

/**
 * Adds pasted images to a composer, as "Image 1", "Image 2", in the order pasted. Returns how many
 * did not fit under the limit.
 */
export function attachImages(draft: string, files: readonly File[]): number {
  const items = draftAttachments(draft)
  const room = Math.max(0, ATTACHMENT_LIMIT - items.length)
  const taken = files.slice(0, room)
  let number = nextImageNumber(items)
  const added: DraftAttachment[] = taken.map((file) => ({
    key: `a${nextKey++}`,
    name: i18n.t('composer:attachments.imageName', { number: number++ }),
    status: 'adding',
    attachment: null,
    thumb: null,
    size: file.size,
    pixels: null,
    scaled: null,
    error: null,
  }))
  setDraftAttachments(draft, [...items, ...added])
  added.forEach((item, i) => void addImage(draft, item, taken[i]!))
  return files.length - taken.length
}

function nextImageNumber(items: readonly DraftAttachment[]): number {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const [before = '', after = ''] = i18n
    .t('composer:attachments.imageName', { number: '\u0000' })
    .split('\u0000')
  const pattern = new RegExp(`^${escape(before)}(\\d+)${escape(after)}$`)
  let highest = 0
  for (const item of items) {
    const match = pattern.exec(item.name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

async function addImage(draft: string, item: DraftAttachment, file: File): Promise<void> {
  try {
    const image = await prepareImage(file)
    if (!isHeld(draft, item.key)) return
    patchDraftAttachment(draft, item.key, {
      thumb: image.thumb,
      size: image.bytes.byteLength,
      pixels: { width: image.width, height: image.height },
      scaled: image.scaled,
    })
    const attachment = await host('attachments.add', {
      source: { bytes: image.bytes, mimeType: image.mimeType, name: item.name },
      thumb: image.thumb,
    })
    // Removed while it was being added: the host's record goes too.
    if (!isHeld(draft, item.key)) {
      void host('attachments.remove', { id: attachment.id }).catch(() => {})
      return
    }
    patchDraftAttachment(draft, item.key, { status: 'ready', attachment })
  } catch (error) {
    console.warn(`Could not attach ${item.name}`, error)
    patchDraftAttachment(draft, item.key, { status: 'failed', error: errorMessage(error) })
  }
}

function isHeld(draft: string, key: string): boolean {
  return draftAttachments(draft).some((item) => item.key === key)
}

export function removeAttachment(draft: string, key: string): void {
  const items = draftAttachments(draft)
  const item = items.find((i) => i.key === key)
  if (!item) return
  setDraftAttachments(
    draft,
    items.filter((i) => i.key !== key),
  )
  if (item.attachment) {
    void host('attachments.remove', { id: item.attachment.id }).catch((error: unknown) =>
      console.warn(`Could not remove attachment ${item.attachment!.id}`, error),
    )
  }
}

export interface AttachmentsBlock {
  message: string
  /** Said in the line under the box too, not only in the send button's tooltip. */
  notice: boolean
}

/** Why the attachments keep a message from being sent, or null when they do not. */
export function attachmentsBlock(
  items: readonly DraftAttachment[],
  text: string,
): AttachmentsBlock | null {
  if (items.length === 0) return null
  if (items.some((item) => item.status === 'failed')) {
    return { message: i18n.t('composer:attachments.removeFailed'), notice: false }
  }
  if (items.some((item) => item.status === 'adding')) {
    return { message: i18n.t('composer:attachments.adding'), notice: false }
  }
  // Counted as the host counts it, so a message it would refuse never leaves.
  const bytes = items.reduce(
    (sum, item) => sum + sentBytes(item.size ?? 0),
    new TextEncoder().encode(text).byteLength,
  )
  if (bytes > PROMPT_BYTES) {
    return { message: i18n.t('composer:attachments.tooLarge'), notice: true }
  }
  return null
}

/** The refs a message carries for its attachments, in the order they were added. */
export function attachmentContent(items: readonly DraftAttachment[]): UserContent[] {
  return items.flatMap((item) =>
    item.attachment
      ? [{ type: 'ref', ref: { kind: 'attachment', attachment: item.attachment } }]
      : [],
  )
}

/** Attachments a queued message held, back in a composer as added ones. */
export function restoreAttachments(draft: string, content: readonly UserContent[]): void {
  const restored: DraftAttachment[] = content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment'
      ? [
          {
            key: `a${nextKey++}`,
            name: c.ref.attachment.name,
            status: 'ready' as const,
            attachment: c.ref.attachment,
            thumb: c.ref.attachment.thumb,
            size: c.ref.attachment.size,
            pixels: null,
            scaled: null,
            error: null,
          },
        ]
      : [],
  )
  if (restored.length === 0) return
  const items = draftAttachments(draft)
  setDraftAttachments(draft, [...items, ...restored].slice(0, ATTACHMENT_LIMIT))
}
