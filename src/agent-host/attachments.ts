// The attachments of drafts and queued prompts: their records in state/attachments.json and the
// bytes the renderer handed over in attachments/, named by SHA-256 and extension, until a prompt
// sends them or the user removes them. See docs/design/session-model.md#where-the-bytes-live.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AttachmentBytes } from '@shared/agent-host'
import { MODEL_IMAGE_TYPES } from '@shared/attachments'
import type { Attachment } from '@shared/thread'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
import { JsonFile, type LogFn } from './storage'

/** A record nothing sent or removed in this long is dropped when the host starts. */
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

  /** Reads the records, dropping old ones, and the saved bytes that no record or link needs. */
  async load(): Promise<void> {
    const data = await this.file.load()
    const cutoff = this.now() - ATTACHMENT_MAX_AGE_MS
    for (const record of data.attachments) {
      if (record.addedAt >= cutoff) this.records.set(record.id, record)
    }
    if (this.records.size !== data.attachments.length) this.save()
    const kept = new Set([...this.records.values()].map(fileName))
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    // Bytes no record holds may still be what a sent link points to, so only old ones go.
    for (const name of names) {
      if (kept.has(name)) continue
      const file = path.join(this.dir, name)
      try {
        if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true })
      } catch (error) {
        this.options.log('warn', `Could not remove ${file}: ${(error as Error).message}`)
      }
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

  /** The saved file's URI, for an agent that is sent a link rather than the bytes. */
  fileUri(record: AttachmentRecord): string {
    return pathToFileURL(this.bytesPath(record)).href
  }

  async remove(id: string): Promise<void> {
    this.get(id)
    await this.release([id])
  }

  /**
   * Drops the records once their prompt went or they were removed, and their bytes unless
   * another record or a link sent to an agent (`linked`) still needs them.
   */
  async release(ids: readonly string[], linked: ReadonlySet<string> = new Set()): Promise<void> {
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
      if (kept.has(fileName(record)) || linked.has(record.hash)) continue
      await rm(this.bytesPath(record), { force: true }).catch((error: unknown) =>
        this.options.log('warn', `Could not remove attachment bytes: ${(error as Error).message}`),
      )
    }
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private bytesPath(record: Pick<AttachmentRecord, 'hash' | 'mimeType'>): string {
    return path.join(this.dir, fileName(record))
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
