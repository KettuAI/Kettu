// The attachments of drafts and queued prompts: their records in state/attachments.json and the
// bytes the renderer handed over in attachments/, named by SHA-256 and extension, until a prompt
// sends them or the user removes them; and in attachments/sent/, the copies that links sent to an
// agent point to. See docs/design/session-model.md#where-the-bytes-live.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AttachmentBytes } from '@shared/agent-host'
import { MODEL_IMAGE_TYPES } from '@shared/attachments'
import type { Attachment } from '@shared/thread'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
import { JsonFile, type LogFn } from './storage'

/** A record nothing sent or removed in this long, or a sent copy this old, goes when the host starts. */
export const ATTACHMENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface AttachmentRecord {
  id: string
  type: 'image'
  name: string
  mimeType: string
  size: number
  hash: string
  thumb: string | null
  addedAt: number
}

export interface AttachmentsFile {
  version: 1
  attachments: AttachmentRecord[]
}

const HASH = /^[0-9a-f]{64}$/

// An agent sent a link decides by the name whether the file is a picture.
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

function fileName(record: Pick<AttachmentRecord, 'hash' | 'mimeType'>): string {
  return `${record.hash}${EXTENSIONS[record.mimeType] ?? ''}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isAttachmentRecord(value: unknown): value is AttachmentRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.type === 'image' &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.size === 'number' &&
    typeof value.hash === 'string' &&
    HASH.test(value.hash) &&
    (value.thumb === null || typeof value.thumb === 'string') &&
    typeof value.addedAt === 'number'
  )
}

export function parseAttachmentsFile(data: Record<string, unknown>): AttachmentsFile | string {
  if (!Array.isArray(data.attachments)) return 'attachments is not a list'
  // One bad record costs only itself.
  return { version: 1, attachments: data.attachments.filter(isAttachmentRecord) }
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
      if (record.addedAt >= cutoff) this.records.set(record.id, record)
    }
    if (this.records.size !== data.attachments.length) this.save()
    const kept = new Set([...this.records.values()].map(fileName))
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

  async add(
    source: { bytes: ArrayBuffer; mimeType: string; name: string },
    thumb: string | null,
  ): Promise<Attachment> {
    if (!MODEL_IMAGE_TYPES.includes(source.mimeType)) {
      throw invalidParams(`${source.mimeType} is not an image type a model takes`)
    }
    const data = new Uint8Array(source.bytes)
    const hash = createHash('sha256').update(data).digest('hex')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFile(this.bytesPath({ hash, mimeType: source.mimeType }), data, { mode: 0o600 })
    const record: AttachmentRecord = {
      id: randomUUID(),
      type: 'image',
      name: source.name,
      mimeType: source.mimeType,
      size: data.byteLength,
      hash,
      thumb,
      addedAt: this.now(),
    }
    this.records.set(record.id, record)
    this.save()
    return attachmentOf(record)
  }

  /** The record of a draft's attachment; `not_found` once it was sent, removed or dropped. */
  get(id: string): AttachmentRecord {
    const record = this.records.get(id)
    if (!record) throw notFound(t('session.attachmentMissing'))
    return record
  }

  /** The attachment as the composer and the thread show it, before it is sent. */
  view(id: string): Attachment {
    return attachmentOf(this.get(id))
  }

  async bytes(record: AttachmentRecord): Promise<Buffer> {
    try {
      return await readFile(this.bytesPath(record))
    } catch {
      throw notFound(t('session.attachmentGone', { name: record.name }))
    }
  }

  async read(id: string): Promise<AttachmentBytes> {
    const record = this.get(id)
    const data = await this.bytes(record)
    return { mimeType: record.mimeType, bytes: toArrayBuffer(data) }
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
    const kept = new Set([...this.records.values()].map(fileName))
    for (const record of released) {
      if (!kept.has(fileName(record))) await this.removeFile(this.bytesPath(record))
    }
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private get sentDir(): string {
    return path.join(this.dir, 'sent')
  }

  private bytesPath(record: Pick<AttachmentRecord, 'hash' | 'mimeType'>): string {
    return path.join(this.dir, fileName(record))
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

function attachmentOf(record: AttachmentRecord): Attachment {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    uri: null,
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
