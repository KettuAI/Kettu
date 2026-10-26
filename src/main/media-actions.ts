// What the viewer does with a media item: copy the picture, save a copy, show the file. A file is
// named by its media URL and resolved through the grants; carried media arrives as its bytes.

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  app,
  type BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  nativeImage,
  shell,
} from 'electron'
import { CARRIED_MEDIA_BYTES, type CarriedMedia, type MediaType } from '@shared/media'
import { safeName } from './artifacts/files'
import { grantedFile, type MediaGrants } from './media'

const MIME_TYPE = /^(?:image|audio|video)\/[\w.+-]{1,100}$/
const NAME_MAX_CHARS = 255

const EXTENSIONS: Record<MediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
}

/** Media the thread carries, from the renderer: untrusted input, checked. */
export function carriedMedia(value: unknown): CarriedMedia {
  if (typeof value !== 'object' || value === null) throw new Error('Not a media item')
  const { bytes, mimeType, name } = value as Record<string, unknown>
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('Carried media needs its bytes')
  }
  if (bytes.byteLength > CARRIED_MEDIA_BYTES) throw new Error('Carried media is over 20 MB')
  if (typeof mimeType !== 'string' || !MIME_TYPE.test(mimeType)) {
    throw new Error('Carried media needs an image, audio or video type')
  }
  if (typeof name !== 'string' || name.length > NAME_MAX_CHARS || name.includes('\0')) {
    throw new Error(`A media name is a string of at most ${NAME_MAX_CHARS} characters`)
  }
  return { bytes, mimeType, name }
}

/** The name a save of carried media suggests, with the extension its type takes. */
export function savedName({ name, mimeType }: Pick<CarriedMedia, 'name' | 'mimeType'>): string {
  const extension = EXTENSIONS[mimeType as MediaType]
  const base = safeName(name, mimeType.slice(0, mimeType.indexOf('/')))
  if (!extension || base.toLowerCase().endsWith(`.${extension}`)) return base
  return `${base}.${extension}`
}

/** `media:copy-image`: the picture on the clipboard, from the granted file or the given bytes. */
export async function copyImage(source: unknown, grants: MediaGrants): Promise<void> {
  let bytes: Uint8Array
  if (typeof source === 'string') {
    const grant = await grantedFile(source, grants)
    if (!grant.mimeType.startsWith('image/')) throw new Error('Only a picture can be copied')
    bytes = await readFile(grant.path)
  } else {
    const carried = carriedMedia(source)
    if (!carried.mimeType.startsWith('image/')) throw new Error('Only a picture can be copied')
    bytes = carried.bytes
  }
  // Electron decodes PNG and JPEG here; the renderer hands carried pictures over as PNG.
  const image = nativeImage.createFromBuffer(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  )
  if (image.isEmpty()) throw new Error("This picture's format can't be copied")
  const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
  await clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/** `media:save-as`: a copy where the save dialog says, in Downloads at first; false if none. */
export async function saveMediaAs(
  window: BrowserWindow | null,
  source: unknown,
  grants: MediaGrants,
): Promise<boolean> {
  let name: string
  let save: (to: string) => Promise<void>
  if (typeof source === 'string') {
    const grant = await grantedFile(source, grants)
    name = path.basename(grant.path)
    save = (to) => copyFile(grant.path, to)
  } else {
    const carried = carriedMedia(source)
    name = savedName(carried)
    save = (to) => writeFile(to, carried.bytes)
  }
  const options: Electron.SaveDialogOptions = {
    defaultPath: path.join(app.getPath('downloads'), name),
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return false
  await save(result.filePath)
  return true
}

/** `media:reveal`: the granted file, selected in the file manager and never run. */
export async function revealMedia(url: unknown, grants: MediaGrants): Promise<void> {
  shell.showItemInFolder((await grantedFile(url, grants)).path)
}
