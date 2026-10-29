// A composer's attachments: adding pasted images and long pasted texts, picked, pasted or dropped
// files and folders, and the project's files and folders an `@` mention names, through the host,
// removing them, keeping them with the draft across a restart, and the content refs a message
// carries.

import {
  ATTACHMENT_LIMIT,
  PASTED_TEXT_CHARS,
  PROMPT_BYTES,
  promptShare,
  textThumb,
  type GrantedAttachment,
} from '@shared/attachments'
import type { Attachment, UserContent } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import {
  draftAttachments,
  patchDraftAttachment,
  setDraftAttachments,
  useAttachmentsStore,
  type DraftAttachment,
} from '@renderer/stores/attachments'
import {
  draftIds,
  readDraftAttachments,
  writeDraftAttachments,
  type SavedAttachment,
} from './drafts'
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
  let number = nextNumber(items, 'composer:attachments.imageName')
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

/** The next number of a numbered name in a draft: one past the highest it holds. */
function nextNumber(
  items: readonly DraftAttachment[],
  key: 'composer:attachments.imageName' | 'composer:attachments.pastedTextName',
): number {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const [before = '', after = ''] = i18n.t(key, { number: '\u0000' }).split('\u0000')
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

/** The text of a paste that becomes a pasted text attachment, or null when it stays text. */
export function pastedText(data: DataTransfer): string | null {
  const text = data.getData('text/plain')
  return text.length > PASTED_TEXT_CHARS ? text : null
}

/**
 * Adds a long paste as "Pasted text 1", "Pasted text 2", in the order pasted. Returns 1 when the
 * composer is full, and nothing is added.
 */
export function attachPastedText(draft: string, text: string): number {
  const items = draftAttachments(draft)
  if (items.length >= ATTACHMENT_LIMIT) return 1
  const bytes = new TextEncoder().encode(text)
  const item: DraftAttachment = {
    key: `a${nextKey++}`,
    name: i18n.t('composer:attachments.pastedTextName', {
      number: nextNumber(items, 'composer:attachments.pastedTextName'),
    }),
    kind: 'text',
    status: 'adding',
    attachment: null,
    thumb: textThumb(text),
    size: bytes.byteLength,
    pixels: null,
    scaled: null,
    error: null,
  }
  setDraftAttachments(draft, [...items, item])
  void addText(draft, item, bytes)
  return 0
}

/** Puts a pasted text back as text through `insert`, and removes its tile and its record. */
export function pasteAsText(
  draft: string,
  key: string,
  text: string,
  insert: (text: string) => void,
): void {
  insert(text)
  removeAttachment(draft, key)
}

async function addText(draft: string, item: DraftAttachment, bytes: Uint8Array): Promise<void> {
  try {
    const attachment = await host('attachments.add', {
      source: { bytes: bytes.buffer as ArrayBuffer, mimeType: 'text/plain', name: item.name },
      thumb: null,
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
  return addAllGranted(draft, await window.kettu.attachments.pick(kind, folder))
}

/**
 * Adds the files and folders a paste carries when they were copied in the file manager: every one
 * copied, granted by main, not only those the paste event holds, and none of the image or text the
 * file manager puts beside them. Null when the paste has no file on disk, so it is an image or
 * text. Resolves to how many did not fit under the limit.
 */
export function attachPastedFiles(draft: string, data: DataTransfer): Promise<number> | null {
  const files = [...data.files]
  if (files.length === 0) return null
  const pending = window.kettu.attachments.fromClipboard(files.slice(0, ATTACHMENT_LIMIT))
  if (!pending) return null
  return pending.then((granted) =>
    // More than fit in a message were copied, whichever of them main could grant.
    Math.max(
      addAllGranted(draft, granted),
      files.length > ATTACHMENT_LIMIT ? files.length - ATTACHMENT_LIMIT : 0,
    ),
  )
}

/** Adds granted files and folders, as many as fit. Returns how many did not. */
function addAllGranted(draft: string, granted: readonly GrantedAttachment[]): number {
  const taken = granted.slice(0, attachmentRoom(draft))
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
    granted = await window.kettu.attachments.fromFiles([...taken])
  } catch (error) {
    for (const item of added) {
      patchDraftAttachment(draft, item.key, { status: 'failed', error: errorMessage(error) })
    }
    return files.length - taken.length
  }
  added.forEach((item, i) => {
    const grant = granted[i]
    const file = taken[i]!
    if (grant) {
      void addGranted(draft, item, grant, file)
    } else if (file.type.startsWith('image/')) {
      // An image dragged out of a page has no file on disk; it is added as a pasted one is.
      patchDraftAttachment(draft, item.key, { kind: 'image' })
      void addImage(draft, item, file)
    } else {
      const error = i18n.t('composer:attachments.notOnDisk')
      patchDraftAttachment(draft, item.key, { status: 'failed', error })
    }
  })
  return files.length - taken.length
}

/**
 * Adds a file or folder of the project that an `@` mention chose, by its path relative to the
 * project. Returns how many did not fit under the limit: 1 when the composer is full.
 */
export function attachMention(
  draft: string,
  projectPath: string,
  path: string,
  folder: boolean,
): number {
  if (attachmentRoom(draft) === 0) return 1
  const item = addingTile(path.slice(path.lastIndexOf('/') + 1), null, folder)
  setDraftAttachments(draft, [...draftAttachments(draft), item])
  void addFromHost(draft, item, { projectPath, path }, null)
  return 0
}

function addGranted(
  draft: string,
  item: DraftAttachment,
  grant: GrantedAttachment,
  file: File | null,
): Promise<void> {
  patchDraftAttachment(draft, item.key, {
    kind: grant.kind === 'folder' ? 'folder' : item.kind,
    size: grant.size,
  })
  return addFromHost(draft, item, { grantId: grant.grantId }, file)
}

/**
 * Adds one granted or mentioned file or folder. An image's thumbnail and scaled copy are made from
 * the dropped File, or from the bytes the host read for a picked or mentioned one, and handed back
 * with `attachments.update`.
 */
async function addFromHost(
  draft: string,
  item: DraftAttachment,
  source: { grantId: string } | { projectPath: string; path: string },
  file: File | null,
): Promise<void> {
  let attachment: Attachment | null = null
  try {
    attachment = await host('attachments.add', { source, thumb: null })
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

/** An attachment the host holds, as a ready tile. */
function readyTile({ attachment, pixels, scaled }: SavedAttachment): DraftAttachment {
  return {
    key: `a${nextKey++}`,
    name: attachment.name,
    kind: attachment.type,
    status: 'ready',
    attachment,
    thumb: attachment.thumb,
    size: attachment.size,
    pixels,
    scaled,
    error: null,
  }
}

/** The attachment refs of a message, as they were before it was sent. */
export function contentAttachments(content: readonly UserContent[]): Attachment[] {
  return content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment] : [],
  )
}

/**
 * Attachments a queued or unsent message held, back in a composer as added ones. Returns how many
 * did not fit under the limit; their records go.
 */
export function restoreAttachments(draft: string, content: readonly UserContent[]): number {
  const restored = contentAttachments(content).map((attachment) =>
    readyTile({ attachment, pixels: null, scaled: null }),
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

/** What a draft keeps of its attachments: the added ones, in order. */
function savedOf(items: readonly DraftAttachment[]): SavedAttachment[] {
  return items.flatMap((item) =>
    item.status === 'ready' && item.attachment
      ? [{ attachment: item.attachment, pixels: item.pixels, scaled: item.scaled }]
      : [],
  )
}

const idsOf = (saved: readonly SavedAttachment[]) => saved.map((s) => s.attachment.id).join('\n')

let keeping = false

/**
 * Puts the attachments each draft kept back in its composer, and from then on keeps a composer's
 * added attachments with its draft. The host then says which records it still holds; one it no
 * longer does fails as "No longer available".
 */
export async function restoreDraftAttachments(): Promise<void> {
  if (keeping) return
  keeping = true
  const written = new Map<string, string>()
  const ids: string[] = []
  for (const draft of draftIds()) {
    const saved = readDraftAttachments(draft)
    if (saved.length === 0 || draftAttachments(draft).length > 0) continue
    setDraftAttachments(draft, saved.map(readyTile))
    written.set(draft, idsOf(saved))
    ids.push(...saved.map((s) => s.attachment.id))
  }
  useAttachmentsStore.subscribe((state, previous) => {
    if (state.byDraft === previous.byDraft) return
    for (const draft of new Set([
      ...Object.keys(state.byDraft),
      ...Object.keys(previous.byDraft),
    ])) {
      const items = state.byDraft[draft]
      if (items === previous.byDraft[draft]) continue
      // Most changes are a tile being added; the draft is written only when its added ones change.
      const saved = savedOf(items ?? [])
      const key = idsOf(saved)
      if ((written.get(draft) ?? '') === key) continue
      written.set(draft, key)
      writeDraftAttachments(draft, saved)
    }
  })
  if (ids.length === 0) return
  let held: Set<string>
  try {
    held = new Set(await host('attachments.held', { ids }))
  } catch (error) {
    // Sending then names the missing one, as the host refuses it.
    console.warn(`Could not check the drafts' attachments: ${errorMessage(error)}`)
    return
  }
  const asked = new Set(ids)
  const { byDraft } = useAttachmentsStore.getState()
  for (const [draft, items] of Object.entries(byDraft)) {
    for (const item of items) {
      const id = item.attachment?.id
      if (!id || !asked.has(id) || held.has(id)) continue
      // With no record left, removing the tile has nothing to remove.
      patchDraftAttachment(draft, item.key, {
        status: 'failed',
        attachment: null,
        gone: true,
        error: i18n.t('composer:attachments.unavailableLong'),
      })
    }
  }
}
