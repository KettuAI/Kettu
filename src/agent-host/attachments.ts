// The attachments of drafts and queued prompts: their records in state/attachments.json, the
// paths main granted for picked and dropped files or an `@` mention named, and the image, pasted
// text and other file bytes they were read as or a window or device handed over in attachments/,
// named by SHA-256 and extension,
// until a prompt sends them or the user removes them; and in attachments/sent/, the copies that
// links sent to an agent point to.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AttachmentBytes, PromptCapabilities } from '@shared/agent-host'
import {
  ATTACHMENT_BYTES,
  EMBED_BYTES,
  isTextType,
  MODEL_IMAGE_TYPES,
  textThumb,
  type AttachmentGrant,
} from '@shared/attachments'
import type { Attachment } from '@shared/thread'
import type { PromptBlock } from './connection'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
import { JsonFile, type LogFn } from './storage'
import type { StoredBlob } from './threads/model'

/**
 * A record nothing sent, removed or named in a draft in this long, or a sent copy this old, goes
 * when the host starts.
 */
export const ATTACHMENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** A grant the renderer never used, as for files past the limit, goes after this long. */
const GRANT_MAX_AGE_MS = 10 * 60 * 1000

export interface AttachmentRecord {
  id: string
  type: 'image' | 'file' | 'folder' | 'text'
  name: string
  mimeType: string | null
  /** Bytes: what was saved, or a granted file's when added; null for a folder. */
  size: number | null
  /**
   * SHA-256 of the saved bytes: an image's, as pasted, read when added or scaled, a text's, or a
   * file's handed over as bytes.
   */
  hash: string | null
  /**
   * What main granted, or a mention named, for a file or folder; the only path a record reads.
   * Null for one whose bytes are saved.
   */
  path: string | null
  thumb: string | null
  addedAt: number
  /** When a draft last named it, as the renderer checks its drafts at launch; the age counts from here. */
  heldAt?: number
  /** A text's saved extension, from its type; a text saved before texts took one is `.txt`. */
  extension?: string
}

export interface AttachmentsFile {
  version: 1
  attachments: AttachmentRecord[]
}

export type AttachmentSource =
  { bytes: ArrayBuffer; mimeType: string; name: string } | { grantId: string }

/** A granted path as it is when it is read: resolved, and still the kind it was granted as. */
export interface ResolvedPath {
  real: string
  size: number
}

const HASH = /^[0-9a-f]{64}$/

// An agent sent a link decides by the name whether the file is a picture.
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

// The types a text file gets by its extension; every one is a text type to `isTextType`.
const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.swift': 'text/x-swift',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.sql': 'application/sql',
  '.sh': 'application/x-sh',
  '.svg': 'image/svg+xml',
}

// A text's extension by its type: the first one `TEXT_TYPES` gives it.
const TEXT_EXTENSIONS = new Map<string, string>()
for (const [extension, type] of Object.entries(TEXT_TYPES)) {
  if (!TEXT_EXTENSIONS.has(type)) TEXT_EXTENSIONS.set(type, extension)
}

// Other names devices send text types by, as a phone names Markdown and Python.
const TYPE_ALIASES: Record<string, string> = {
  'text/x-markdown': 'text/markdown',
  'text/x-python-script': 'text/x-python',
}

// The types of other files, for the links an agent gets to them.
const OTHER_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
}

// The same prefix git looks at to call a file binary.
const TEXT_PROBE_BYTES = 8_000
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A file's text when an agent can be given it whole: valid UTF-8, with no NUL where git looks. */
export function textOf(data: Uint8Array): string | null {
  if (data.subarray(0, TEXT_PROBE_BYTES).includes(0)) return null
  try {
    return utf8.decode(data)
  } catch {
    return null
  }
}

/** One of the image types every model takes, by its signature, not its name. */
function modelImageType(data: Uint8Array): string | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(data.subarray(start, end)).toString('latin1')
  if (data[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n') return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

const PLAIN_EXTENSION = /^\.[a-z0-9]{1,16}$/

type Named = Pick<AttachmentRecord, 'type' | 'name' | 'hash' | 'mimeType' | 'extension'>

function fileName(record: Named): string {
  if (record.type === 'file') {
    // An agent's tools tell what a file is by its name, so it keeps the extension it was given.
    const extension = path.extname(record.name).toLowerCase()
    return `${record.hash}${PLAIN_EXTENSION.test(extension) ? extension : ''}`
  }
  if (record.type === 'text' && record.extension) return `${record.hash}${record.extension}`
  const mimeType = record.mimeType ?? ''
  return `${record.hash}${EXTENSIONS[mimeType] ?? (isTextType(mimeType) ? '.txt' : '')}`
}

/** The name of the saved bytes of each record that has them. */
function savedNames(records: Iterable<AttachmentRecord>): Set<string> {
  const names = new Set<string>()
  for (const record of records) if (record.hash) names.add(fileName(record))
  return names
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

/** A stored record, or null; one stored before files could be attached is an image without a path. */
function attachmentRecord(value: unknown): AttachmentRecord | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isStringOrNull(value.mimeType) ||
    (value.size !== null && typeof value.size !== 'number') ||
    !isStringOrNull(value.thumb) ||
    typeof value.addedAt !== 'number' ||
    (value.heldAt !== undefined && typeof value.heldAt !== 'number') ||
    (value.extension !== undefined &&
      (value.type !== 'text' ||
        typeof value.extension !== 'string' ||
        !PLAIN_EXTENSION.test(value.extension)))
  ) {
    return null
  }
  const hash = value.hash ?? null
  const granted = value.path ?? null
  if (!isStringOrNull(hash) || (hash !== null && !HASH.test(hash)) || !isStringOrNull(granted)) {
    return null
  }
  const saved = hash !== null && value.mimeType !== null && typeof value.size === 'number'
  const valid =
    value.type === 'image'
      ? saved
      : value.type === 'text'
        ? saved && granted === null
        : value.type === 'file'
          ? granted !== null
            ? hash === null && typeof value.size === 'number'
            : saved
          : value.type === 'folder' && granted !== null && hash === null && value.size === null
  if (!valid) return null
  return {
    id: value.id,
    type: value.type as AttachmentRecord['type'],
    name: value.name,
    mimeType: value.mimeType,
    size: value.size as number | null,
    hash,
    path: granted,
    thumb: value.thumb,
    addedAt: value.addedAt,
    ...(value.heldAt !== undefined ? { heldAt: value.heldAt as number } : {}),
    ...(value.extension !== undefined ? { extension: value.extension as string } : {}),
  }
}

export function parseAttachmentsFile(data: Record<string, unknown>): AttachmentsFile | string {
  if (!Array.isArray(data.attachments)) return 'attachments is not a list'
  // One bad record costs only itself.
  return {
    version: 1,
    attachments: data.attachments.flatMap((value) => attachmentRecord(value) ?? []),
  }
}

export interface AttachmentsOptions {
  userDataPath: string
  log: LogFn
  now?: () => number
}

export class Attachments {
  private readonly file: JsonFile<AttachmentsFile>
  private readonly dir: string
  private readonly now: () => number
  private readonly records = new Map<string, AttachmentRecord>()
  private readonly grants = new Map<string, AttachmentGrant & { at: number }>()

  constructor(private readonly options: AttachmentsOptions) {
    this.now = options.now ?? Date.now
    this.dir = path.join(options.userDataPath, 'attachments')
    this.file = new JsonFile<AttachmentsFile>({
      file: path.join(options.userDataPath, 'state', 'attachments.json'),
      version: 1,
      migrations: {},
      parse: parseAttachmentsFile,
      empty: () => ({ version: 1, attachments: [] }),
      log: options.log,
      now: this.now,
    })
  }

  /** Reads the records, dropping old ones, the saved bytes no record holds, and old sent copies. */
  async load(): Promise<void> {
    const data = await this.file.load()
    const cutoff = this.now() - ATTACHMENT_MAX_AGE_MS
    for (const record of data.attachments) {
      if ((record.heldAt ?? record.addedAt) >= cutoff) this.records.set(record.id, record)
    }
    if (this.records.size !== data.attachments.length) this.save()
    const kept = savedNames(this.records.values())
    for (const name of await this.files(this.dir)) {
      if (!kept.has(name)) await this.removeFile(path.join(this.dir, name))
    }
    for (const name of await this.files(this.sentDir)) {
      const file = path.join(this.sentDir, name)
      const old = await stat(file).then(
        (info) => info.mtimeMs < cutoff,
        () => false,
      )
      if (old) await this.removeFile(file)
    }
  }

  /** Takes the paths main granted for picked or dropped files; each serves one attachment. */
  grant(grants: readonly AttachmentGrant[]): void {
    const now = this.now()
    for (const [id, grant] of this.grants) {
      if (grant.at < now - GRANT_MAX_AGE_MS) this.grants.delete(id)
    }
    for (const grant of grants) this.grants.set(grant.grantId, { ...grant, at: now })
  }

  /**
   * Bytes of an image type a model takes become an image, of a text type a pasted text, and of any
   * other type, such as a PDF or an archive a device sends, a file the agent gets a link to.
   */
  async add(source: AttachmentSource, thumb: string | null): Promise<Attachment> {
    if ('grantId' in source) return this.addGranted(source.grantId, thumb)
    const mimeType = TYPE_ALIASES[source.mimeType] ?? source.mimeType
    if (isTextType(mimeType)) return this.addText({ ...source, mimeType })
    const data = new Uint8Array(source.bytes)
    const image = MODEL_IMAGE_TYPES.includes(mimeType)
    const named: Omit<Named, 'hash'> = {
      type: image ? 'image' : 'file',
      name: source.name,
      mimeType,
    }
    const record: AttachmentRecord = {
      id: randomUUID(),
      ...named,
      size: data.byteLength,
      hash: await this.saveBytes(data, named),
      path: null,
      thumb: image ? thumb : null,
      addedAt: this.now(),
    }
    this.records.set(record.id, record)
    this.save()
    return attachmentOf(record)
  }

  /** A pasted text, whose tile is made here from its first lines. */
  private async addText(source: {
    bytes: ArrayBuffer
    mimeType: string
    name: string
  }): Promise<Attachment> {
    const data = new Uint8Array(source.bytes)
    const text = textOf(data)
    if (text === null) throw invalidParams(`${source.name} is not UTF-8 text`)
    const named = {
      type: 'text',
      name: source.name,
      mimeType: source.mimeType,
      extension: TEXT_EXTENSIONS.get(source.mimeType) ?? '.txt',
    } as const
    const record: AttachmentRecord = {
      id: randomUUID(),
      ...named,
      size: data.byteLength,
      hash: await this.saveBytes(data, named),
      path: null,
      thumb: textThumb(text),
      addedAt: this.now(),
    }
    this.records.set(record.id, record)
    this.save()
    return attachmentOf(record)
  }

  private addGranted(grantId: string, thumb: string | null): Promise<Attachment> {
    const grant = this.grants.get(grantId)
    this.grants.delete(grantId)
    if (!grant || grant.at < this.now() - GRANT_MAX_AGE_MS)
      throw invalidParams(`No grant ${grantId}`)
    return this.addPath(grant.path, grant.kind, thumb)
  }

  /**
   * A granted file or folder, or a project's one an `@` mention named once it passed the project's
   * containment. An image a model takes is read now, as its thumbnail is made from this read; a
   * text file is read once more when it is sent, so the agent gets it as it is then.
   */
  async addPath(added: string, kind: 'file' | 'folder', thumb: string | null): Promise<Attachment> {
    const name = path.basename(added) || added
    const resolved = await resolvePath(added, kind, name)
    const base = { id: randomUUID(), name, path: added, thumb: null, addedAt: this.now() }
    let record: AttachmentRecord
    if (kind === 'folder') {
      record = { ...base, type: 'folder', mimeType: null, size: null, hash: null }
    } else {
      const extension = path.extname(name).toLowerCase()
      const named = OTHER_TYPES[extension] ?? null
      const read =
        resolved.size <=
        (named && MODEL_IMAGE_TYPES.includes(named) ? ATTACHMENT_BYTES : EMBED_BYTES)
          ? await readGranted(resolved.real, name)
          : null
      const image = read && named && MODEL_IMAGE_TYPES.includes(named) ? modelImageType(read) : null
      if (read && image) {
        record = {
          ...base,
          type: 'image',
          mimeType: image,
          size: read.byteLength,
          hash: await this.saveBytes(read, { type: 'image', name, mimeType: image }),
          thumb,
        }
      } else {
        // Found to be text or not when it was small enough to read; otherwise named by its extension.
        const text = read !== null && read.byteLength <= EMBED_BYTES && textOf(read) !== null
        const mimeType = read
          ? text
            ? (TEXT_TYPES[extension] ?? 'text/plain')
            : (named ?? 'application/octet-stream')
          : (TEXT_TYPES[extension] ?? named)
        record = { ...base, type: 'file', mimeType, size: resolved.size, hash: null }
      }
    }
    this.records.set(record.id, record)
    this.save()
    return attachmentOf(record)
  }

  /**
   * Sets an image's thumbnail, made from what was read, and when it was too large, or of a type no
   * model takes, replaces its bytes with the copy the renderer scaled.
   */
  async update(
    id: string,
    thumb: string | null,
    scaled: { bytes: ArrayBuffer; mimeType: string } | null,
  ): Promise<Attachment> {
    const record = this.get(id)
    if (record.type !== 'image') throw invalidParams(`${record.name} is not an image`)
    let next: AttachmentRecord = { ...record, thumb }
    if (scaled) {
      if (!MODEL_IMAGE_TYPES.includes(scaled.mimeType)) {
        throw invalidParams(`${scaled.mimeType} is not an image type a model takes`)
      }
      const data = new Uint8Array(scaled.bytes)
      const named = { type: 'image', name: record.name, mimeType: scaled.mimeType } as const
      const hash = await this.saveBytes(data, named)
      next = { ...next, mimeType: scaled.mimeType, size: data.byteLength, hash }
    }
    // Removed while the bytes were written: the new copy goes too.
    if (this.records.get(id) !== record) {
      if (scaled) await this.dropUnheld([next])
      throw notFound(t('session.attachmentMissing'))
    }
    this.records.set(id, next)
    this.save()
    if (scaled) await this.dropUnheld([record])
    return attachmentOf(next)
  }

  /** The record of a draft's attachment; `not_found` once it was sent, removed or dropped. */
  get(id: string): AttachmentRecord {
    const record = this.records.get(id)
    if (!record) throw notFound(t('session.attachmentMissing'))
    return record
  }

  /**
   * Which of these records the host still holds, for the drafts that name them; each one's age
   * counts from now, so a draft kept across launches keeps its attachments.
   */
  held(ids: readonly string[]): string[] {
    const at = this.now()
    const held: string[] = []
    for (const id of ids) {
      const record = this.records.get(id)
      if (!record) continue
      // In place: `update` tells a removal from a changed record by its identity.
      record.heldAt = at
      held.push(id)
    }
    if (held.length > 0) this.save()
    return held
  }

  /** The attachment as the composer and the thread show it, before it is sent. */
  view(id: string): Attachment {
    return attachmentOf(this.get(id))
  }

  /** The saved bytes of an image, a pasted text or a file handed over as bytes. */
  async bytes(record: AttachmentRecord): Promise<Buffer> {
    if (!record.hash) throw invalidParams(`${record.name} has no saved bytes`)
    try {
      return await readFile(this.bytesPath(record))
    } catch {
      throw notFound(t('session.attachmentGone', { name: record.name }))
    }
  }

  async read(id: string): Promise<AttachmentBytes> {
    const record = this.get(id)
    const data = await this.bytes(record)
    return { mimeType: record.mimeType!, bytes: toArrayBuffer(data) }
  }

  /** A granted file or folder as it is now; `not_found` when it is gone or no longer that kind. */
  resolve(record: AttachmentRecord): Promise<ResolvedPath> {
    if (!record.path || record.type === 'image' || record.type === 'text') {
      return Promise.reject(invalidParams(`${record.name} has no granted path`))
    }
    return resolvePath(record.path, record.type, record.name)
  }

  /**
   * A link for an agent that is sent one rather than the bytes: to a copy of its own, which stays
   * 30 days after it was last sent, however the draft's record and bytes go.
   */
  async sentLink(record: AttachmentRecord, data: Uint8Array): Promise<string> {
    const file = path.join(this.sentDir, fileName(record))
    await mkdir(this.sentDir, { recursive: true, mode: 0o700 })
    await writeFile(file, data, { mode: 0o600 })
    const at = new Date(this.now())
    await utimes(file, at, at)
    return pathToFileURL(file).href
  }

  async remove(id: string): Promise<void> {
    this.get(id)
    await this.release([id])
  }

  /** Drops the records once their prompt went or they were removed, and their bytes unless another record holds them. */
  async release(ids: readonly string[]): Promise<void> {
    const released: AttachmentRecord[] = []
    for (const id of ids) {
      const record = this.records.get(id)
      if (!record) continue
      this.records.delete(id)
      released.push(record)
    }
    if (released.length === 0) return
    this.save()
    await this.dropUnheld(released)
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private get sentDir(): string {
    return path.join(this.dir, 'sent')
  }

  private bytesPath(record: Named): string {
    return path.join(this.dir, fileName(record))
  }

  private async saveBytes(data: Uint8Array, named: Omit<Named, 'hash'>): Promise<string> {
    const hash = createHash('sha256').update(data).digest('hex')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFile(this.bytesPath({ ...named, hash }), data, { mode: 0o600 })
    return hash
  }

  /** Removes the saved bytes of these records that no record still holds. */
  private async dropUnheld(records: readonly AttachmentRecord[]): Promise<void> {
    const kept = savedNames(this.records.values())
    for (const record of records) {
      if (record.hash && !kept.has(fileName(record))) await this.removeFile(this.bytesPath(record))
    }
  }

  /** The files in a folder, none when it does not exist yet. */
  private async files(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  private async removeFile(file: string): Promise<void> {
    await rm(file, { force: true }).catch((error: unknown) =>
      this.options.log('warn', `Could not remove ${file}: ${(error as Error).message}`),
    )
  }

  private save(): void {
    this.file.save({ version: 1, attachments: [...this.records.values()] })
  }
}

/** A granted path resolved with `realpath`, which must still be the kind it was granted as. */
export async function resolvePath(
  granted: string,
  kind: 'file' | 'folder',
  name: string,
): Promise<ResolvedPath> {
  try {
    const real = await realpath(granted)
    const info = await stat(real)
    if (kind === 'folder' ? info.isDirectory() : info.isFile()) return { real, size: info.size }
  } catch {
    // Gone, or no longer reachable.
  }
  throw notFound(t('session.attachmentGone', { name }))
}

/** The bytes of a granted file, read for the one attachment it was granted for. */
export async function readGranted(real: string, name: string): Promise<Buffer> {
  try {
    return await readFile(real)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const denied = code === 'EACCES' || code === 'EPERM'
    throw notFound(
      t(denied ? 'session.attachmentDenied' : 'session.attachmentUnreadable', { name }),
    )
  }
}

/** A granted file's or folder's `file://` URI; a folder's ends in `/`. */
export function grantedUri(record: Pick<AttachmentRecord, 'type' | 'path'>): string | null {
  if (!record.path) return null
  const href = pathToFileURL(record.path).href
  return record.type === 'folder' && !href.endsWith('/') ? `${href}/` : href
}

/** How an attachment goes to an agent, what its ref says once sent, and the bytes kept for it. */
export interface SentAttachment {
  block: PromptBlock
  changes: Pick<Attachment, 'uri' | 'sent' | 'size' | 'blob'>
  blob: StoredBlob | null
}

/**
 * Builds what goes to the agent for one attachment, from what its prompt capabilities allow: an
 * image as an image or a link, a text file with its contents or as a link, a folder as a link, a
 * pasted text embedded or as text after the message's, and a file handed over as bytes as a link.
 */
export async function sendAttachment(
  store: Attachments,
  record: AttachmentRecord,
  prompt: PromptCapabilities | null,
): Promise<SentAttachment> {
  if (record.type === 'text') {
    const data = await store.bytes(record)
    const blob = { hash: record.hash!, mime: record.mimeType!, data: new Uint8Array(data) }
    if (prompt?.embeddedContext) {
      // Under a copy of its own, which stays after the draft's goes, so the URI still opens.
      const uri = await store.sentLink(record, data)
      return {
        block: pastedTextBlock(data.toString('utf8'), uri, record.mimeType!),
        changes: { uri, sent: 'embedded', size: record.size, blob: blob.hash },
        blob,
      }
    }
    return {
      block: pastedTextBlock(data.toString('utf8'), null, record.mimeType!),
      changes: { uri: null, sent: 'inline', size: record.size, blob: blob.hash },
      blob,
    }
  }
  if (record.type === 'image') {
    const data = await store.bytes(record)
    const blob = { hash: record.hash!, mime: record.mimeType!, data: new Uint8Array(data) }
    const original = grantedUri(record)
    if (prompt?.image) {
      const block: PromptBlock = {
        type: 'image',
        mimeType: record.mimeType!,
        data: data.toString('base64'),
        ...(original ? { uri: original } : {}),
      }
      return {
        block,
        changes: { uri: original, sent: 'image', size: record.size, blob: blob.hash },
        blob,
      }
    }
    // A pasted image has no file of its own, so the link goes to a copy.
    const uri = original ?? (await store.sentLink(record, data))
    return {
      block: linkBlock(uri, record.name, record.mimeType, record.size),
      changes: { uri, sent: 'linked', size: record.size, blob: blob.hash },
      blob,
    }
  }
  if (record.type === 'file' && record.hash) {
    // Handed over as bytes, it has no file of its own, so the link goes to a copy.
    const uri = await store.sentLink(record, await store.bytes(record))
    return {
      block: linkBlock(uri, record.name, record.mimeType, record.size),
      changes: { uri, sent: 'linked', size: record.size, blob: null },
      blob: null,
    }
  }
  const uri = grantedUri(record)!
  const resolved = await store.resolve(record)
  if (record.type === 'folder') {
    return {
      block: linkBlock(uri, record.name, null, null),
      changes: { uri, sent: 'linked', size: null, blob: null },
      blob: null,
    }
  }
  const sent = await embedFile(
    resolved.real,
    uri,
    record.name,
    record.mimeType,
    prompt,
    resolved.size,
  )
  return {
    block: sent.block,
    changes: { uri, sent: sent.sent, size: sent.size, blob: null },
    blob: null,
  }
}

/**
 * A file with its contents when the agent takes embedded context and it is text up to 256 KB,
 * read now so the agent gets it as it is; otherwise a link to it.
 */
export async function embedFile(
  real: string,
  uri: string,
  name: string,
  mimeType: string | null,
  prompt: PromptCapabilities | null,
  size: number,
): Promise<{ block: PromptBlock; sent: 'embedded' | 'linked'; size: number }> {
  if (prompt?.embeddedContext && size <= EMBED_BYTES) {
    const data = await readGranted(real, name)
    const text = data.byteLength <= EMBED_BYTES ? textOf(data) : null
    if (text !== null) {
      const type = isTextType(mimeType) ? mimeType! : 'text/plain'
      const block: PromptBlock = { type: 'resource', resource: { uri, mimeType: type, text } }
      return { block, sent: 'embedded', size: data.byteLength }
    }
  }
  return { block: linkBlock(uri, name, mimeType, size), sent: 'linked', size }
}

/** A pasted text as a `resource` under `uri`, or, with no URI, as text after the message's. */
export function pastedTextBlock(text: string, uri: string | null, mimeType: string): PromptBlock {
  return uri ? { type: 'resource', resource: { uri, mimeType, text } } : { type: 'text', text }
}

/** A block's share of `PROMPT_BYTES`, as the host counts a prompt: text, base64 and embedded text. */
export function blockBytes(block: PromptBlock): number {
  switch (block.type) {
    case 'text':
      return Buffer.byteLength(block.text, 'utf8')
    case 'image':
      return block.data.length
    case 'resource':
      return 'text' in block.resource ? Buffer.byteLength(block.resource.text, 'utf8') : 0
    default:
      return 0
  }
}

/** A `resource_link`, with the type and size when they are known. */
export function linkBlock(
  uri: string,
  name: string,
  mimeType: string | null,
  size: number | null,
): PromptBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    ...(mimeType ? { mimeType } : {}),
    ...(size !== null ? { size } : {}),
  }
}

function attachmentOf(record: AttachmentRecord): Attachment {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    uri: grantedUri(record),
    mimeType: record.mimeType,
    size: record.size,
    sent: null,
    thumb: record.thumb,
    blob: null,
  }
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}
