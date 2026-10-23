// A composer's attachments: adding pasted images, and picked or dropped files and folders, through
// the host, removing them, and the content refs a message carries. See docs/design/ui.md#attachments.

import {
  ATTACHMENT_LIMIT,
  PROMPT_BYTES,
  promptShare,
  type GrantedAttachment,
} from '@shared/attachments'
import type { Attachment, UserContent } from '@shared/thread'
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
    kind: 'image',
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

// The image types the host reads as images when it is granted one; any other file is a file.
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i

/** A tile for a file or folder being added, in the next frame, before its grant is known. */
function addingTile(name: string, size: number | null, folder: boolean): DraftAttachment {
  return {
    key: `a${nextKey++}`,
    name,
    kind: folder ? 'folder' : IMAGE_NAME.test(name) ? 'image' : 'file',
    status: 'adding',
    attachment: null,
    thumb: null,
    size,
    pixels: null,
    scaled: null,
    error: null,
  }
}

/** How many more attachments a composer takes. */
export function attachmentRoom(draft: string): number {
  return Math.max(0, ATTACHMENT_LIMIT - draftAttachments(draft).length)
}

/**
 * Shows the system's file or folder dialog, opening in the session's folder, and adds what was
 * chosen. Returns how many did not fit under the limit.
 */
export async function pickAttachments(
  draft: string,
  kind: 'files' | 'folder',
  folder: string | null,
): Promise<number> {
  const granted = await window.overbench.attachments.pick(kind, folder)
  const room = attachmentRoom(draft)
  const taken = granted.slice(0, room)
  const added = taken.map((grant) => addingTile(grant.name, grant.size, grant.kind === 'folder'))
  setDraftAttachments(draft, [...draftAttachments(draft), ...added])
  added.forEach((item, i) => void addGranted(draft, item, taken[i]!, null))
  return granted.length - taken.length
}

/**
 * Adds dropped files and folders: their tiles at once, then each through main's grant. Returns
 * how many did not fit under the limit.
 */
export async function attachFiles(draft: string, files: readonly File[]): Promise<number> {
  const taken = files.slice(0, attachmentRoom(draft))
  if (taken.length === 0) return files.length
  // A folder is a File too, which only its grant tells apart.
  const added = taken.map((file) => addingTile(file.name, file.size, false))
  setDraftAttachments(draft, [...draftAttachments(draft), ...added])
  let granted: (GrantedAttachment | null)[]
  try {
    granted = await window.overbench.attachments.fromFiles([...taken])
  } catch (error) {
    for (const item of added) {
      patchDraftAttachment(draft, item.key, { status: 'failed', error: errorMessage(error) })
    }
    return files.length - taken.length
  }
  added.forEach((item, i) => {
    const grant = granted[i]
    if (grant) void addGranted(draft, item, grant, taken[i]!)
    else patchDraftAttachment(draft, item.key, { status: 'failed', error: null })
  })
  return files.length - taken.length
}

/**
 * Adds one granted file or folder. An image's thumbnail and scaled copy are made from the dropped
 * File, or from the bytes the host read for a picked one, and handed back with `attachments.update`.
 */
async function addGranted(
  draft: string,
  item: DraftAttachment,
  grant: GrantedAttachment,
  file: File | null,
): Promise<void> {
  patchDraftAttachment(draft, item.key, {
    kind: grant.kind === 'folder' ? 'folder' : item.kind,
    size: grant.size,
  })
  let attachment: Attachment | null = null
  try {
    attachment = await host('attachments.add', { source: { grantId: grant.grantId }, thumb: null })
    if (attachment.type === 'image') {
      patchDraftAttachment(draft, item.key, { kind: 'image' })
      const id = attachment.id
      const image = await prepareImage(
        file ??
          new Blob([(await host('attachments.read', { id })).bytes], {
            type: attachment.mimeType ?? '',
          }),
      )
      // The worker hands back the original unless it had to scale or re-encode it.
      const changed =
        image.bytes.byteLength !== attachment.size || image.mimeType !== attachment.mimeType
      attachment = await host('attachments.update', {
        id,
        thumb: image.thumb,
        scaled: changed ? { bytes: image.bytes, mimeType: image.mimeType } : null,
      })
      patchDraftAttachment(draft, item.key, {
        thumb: image.thumb,
        pixels: { width: image.width, height: image.height },
        scaled: image.scaled,
      })
    } else if (attachment.type !== item.kind) {
      patchDraftAttachment(draft, item.key, { kind: attachment.type })
    }
    // Removed while it was being added: the host's record goes too.
    if (!isHeld(draft, item.key)) {
      void host('attachments.remove', { id: attachment.id }).catch(() => {})
      return
    }
    patchDraftAttachment(draft, item.key, { status: 'ready', attachment, size: attachment.size })
  } catch (error) {
    console.warn(`Could not attach ${item.name}`, error)
    if (attachment && !isHeld(draft, item.key)) {
      void host('attachments.remove', { id: attachment.id }).catch(() => {})
    }
    // Its record, when the host made one, goes when the tile is removed.
    patchDraftAttachment(draft, item.key, {
      status: 'failed',
      attachment,
      error: errorMessage(error),
    })
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
  removeRecord(item)
}

function removeRecord(item: DraftAttachment): void {
  const id = item.attachment?.id
  if (!id) return
  void host('attachments.remove', { id }).catch((error: unknown) =>
    console.warn(`Could not remove attachment ${id}`, error),
  )
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
    (sum, item) => sum + (item.attachment ? promptShare(item.attachment) : 0),
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

/**
 * Attachments a queued message held, back in a composer as added ones. Returns how many did not
 * fit under the limit; their records go.
 */
export function restoreAttachments(draft: string, content: readonly UserContent[]): number {
  const restored: DraftAttachment[] = content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment'
      ? [
          {
            key: `a${nextKey++}`,
            name: c.ref.attachment.name,
            kind: c.ref.attachment.type,
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
  if (restored.length === 0) return 0
  const items = draftAttachments(draft)
  const room = Math.max(0, ATTACHMENT_LIMIT - items.length)
  setDraftAttachments(draft, [...items, ...restored.slice(0, room)])
  const left = restored.slice(room)
  for (const item of left) removeRecord(item)
  return left.length
}

/** Drops a composer's attachments with their records, as when its session is deleted. */
export function dropAttachments(draft: string): void {
  const items = draftAttachments(draft)
  if (items.length === 0) return
  setDraftAttachments(draft, [])
  for (const item of items) removeRecord(item)
}
