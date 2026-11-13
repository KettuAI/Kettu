// Artifacts of the other hosts this computer connects to. Main asks the host which files a version
// has, fetches each file the first time a page or thumbnail asks for it, and keeps them in a folder
// of its own across runs, so the protocol serves them as it serves this computer's; a page's
// capability messages go to the host through a frame it opens there, which names the artifact,
// and the host checks each as it does a paired device's.

import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  errorAnswer,
  messageHeader,
  RUNTIME_VERSION,
  type RuntimeAnswer,
} from '@shared/artifact-capabilities'
import { artifactPathProblem, VERSION_BYTES, VERSION_FILES } from '@shared/artifact-files'
import {
  type ArtifactExportFormat,
  type ArtifactTypeInfo,
  type ExportedFile,
  isArtifactTypeName,
} from '@shared/artifact-types'
import { artifactRef } from '@shared/artifacts'
import type {
  ArtifactContentFile,
  ArtifactContentResult,
  ArtifactExportResult,
} from '@shared/host-control'
import { createLogger } from '../log'
import { ContentCache } from './content-cache'

const log = createLogger('artifacts')

/** The files of one version fetched at a time. */
const PARALLEL = 6
/** What the files kept from other hosts may take; the versions used longest ago go past it. */
export const REMOTE_CACHE_BYTES = 256 * 1024 * 1024
/** How long after a fetch the kept files are checked against their size. */
const PRUNE_DELAY_MS = 10_000
/** A version's folder is marked used at most this often. */
const TOUCH_MS = 60_000
const PART = '.part'
const MAX_TITLE = 1_000
const MAX_FORMAT = 1_000
const FRAME_PATH = /^\/frame\/[A-Za-z0-9_-]{43}\/$/

/** A request to a host whose session is open; rejects with the host's error. */
export type HostCall = (hostId: string, method: string, params: unknown) => Promise<unknown>

export interface RemoteArtifactsDeps {
  call: HostCall
  /** The folder the fetched files lie in, which is main's alone. */
  dir: string
  /** `REMOTE_CACHE_BYTES` unless a test sets less. */
  maxBytes?: number
}

interface Read {
  version: number
  title: string
  type: ArtifactTypeInfo | null
  files: { path: string; size: number }[]
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

function parseType(value: unknown): ArtifactTypeInfo | null | undefined {
  if (value === undefined || value === null) return null
  const { name, format } = value as Record<string, unknown>
  if (!isArtifactTypeName(name)) return undefined
  if (!Number.isSafeInteger(format) || (format as number) < 1 || (format as number) > MAX_FORMAT) {
    return undefined
  }
  return { name, format: format as number }
}

/** A host's answer to `artifacts.read`, checked; null for anything else. */
export function parseRead(value: unknown): Read | null {
  if (typeof value !== 'object' || value === null) return null
  const { version, title, files } = value as Record<string, unknown>
  const type = parseType((value as Record<string, unknown>).type)
  if (!Number.isSafeInteger(version) || (version as number) < 1) return null
  if (typeof title !== 'string' || title.length > MAX_TITLE || type === undefined) return null
  if (!Array.isArray(files) || files.length > VERSION_FILES) return null
  const seen = new Set<string>()
  const list: Read['files'] = []
  let total = 0
  for (const file of files as unknown[]) {
    const { path: name, size } = (file ?? {}) as Record<string, unknown>
    if (typeof name !== 'string' || artifactPathProblem(name) !== null || seen.has(name)) {
      return null
    }
    if (!Number.isSafeInteger(size) || (size as number) < 0) return null
    seen.add(name)
    total += size as number
    list.push({ path: name, size: size as number })
  }
  if (total > VERSION_BYTES) return null
  return { version: version as number, title, type, files: list }
}

function bytesOf(value: unknown): Uint8Array | null {
  const bytes = (value as { bytes?: unknown } | null)?.bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return null
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

function isAnswer(value: unknown): value is RuntimeAnswer {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class RemoteArtifacts {
  private readonly cache: ContentCache
  /** The files being fetched, by where they go; a version's files never change. */
  private readonly fetching = new Map<string, Promise<void>>()
  /** When each version's folder was last marked used. */
  private readonly touched = new Map<string, number>()
  private pruneTimer: ReturnType<typeof setTimeout> | null = null
  private parts = 0
  /** The frame each artifact's messages go through, as its host named it. */
  private readonly frames = new Map<string, Promise<string>>()
  /** The open streams, by host and the name main gave each. */
  private readonly streams = new Map<string, (answer: RuntimeAnswer) => void>()
  private nextStream = 1

  constructor(private readonly deps: RemoteArtifactsDeps) {
    this.cache = new ContentCache((ref, version) => {
      const at = ref.indexOf(':')
      return this.read(ref.slice(0, at), ref.slice(at + 1), version)
    })
  }

  /**
   * Keeps what earlier runs fetched within the size, the versions used longest ago going first,
   * and removes files a fetch left unfinished. A version's files never change, so what is kept
   * stays true for it.
   */
  async prune(): Promise<void> {
    const folders = await readdir(this.deps.dir).catch((): string[] => [])
    const kept: { folder: string; bytes: number; usedAt: number }[] = []
    for (const name of folders) {
      const folder = path.join(this.deps.dir, name)
      const info = await stat(folder).catch(() => null)
      if (!info?.isDirectory()) {
        await rm(folder, { force: true }).catch(() => {})
        continue
      }
      let bytes = 0
      for (const file of await readdir(folder).catch((): string[] => [])) {
        const at = path.join(folder, file)
        if (file.endsWith(PART)) {
          const target = at.slice(0, at.lastIndexOf('.', at.length - PART.length - 1))
          if (!this.fetching.has(target)) await rm(at, { force: true }).catch(() => {})
          continue
        }
        bytes += (await stat(at).catch(() => null))?.size ?? 0
      }
      kept.push({ folder, bytes, usedAt: info.mtimeMs })
    }
    const max = this.deps.maxBytes ?? REMOTE_CACHE_BYTES
    let total = 0
    for (const version of kept.toSorted((a, b) => b.usedAt - a.usedAt)) {
      total += version.bytes
      if (total <= max) continue
      if ([...this.fetching.keys()].some((file) => path.dirname(file) === version.folder)) continue
      await rm(version.folder, { recursive: true, force: true })
      this.touched.delete(version.folder)
    }
  }

  /** The files of a version on the host, the latest when `version` is null, as yet unfetched. */
  content(hostId: string, id: string, version: number | null): Promise<ArtifactContentResult> {
    return this.cache.get(artifactRef(hostId, id), version)
  }

  /**
   * Fetches the files of a version that `paths` names, every one when null, unless a run fetched
   * them before; a path the version does not list is left out.
   */
  async fetch(
    hostId: string,
    id: string,
    version: number,
    paths: readonly string[] | null,
  ): Promise<void> {
    const found = await this.content(hostId, id, version)
    if (found.kind !== 'found') throw new Error(`Host ${hostId} has no version ${version} of ${id}`)
    const files = paths === null ? found.files : found.files.filter((f) => paths.includes(f.path))
    if (files.length === 0) return
    await this.touch(path.dirname(files[0]!.file))
    let next = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < files.length; i = next++) {
        await this.fetchFile(hostId, id, version, files[i]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker))
  }

  /** A host's artifacts changed: its latest versions and titles are asked again. */
  changed(): void {
    this.cache.clear()
  }

  /** The host's session ended, and with it the frames it opened and the streams on them. */
  ended(hostId: string): void {
    this.cache.clear()
    for (const key of [...this.frames.keys()]) {
      if (key.startsWith(`${hostId}:`)) this.frames.delete(key)
    }
    for (const [key, answer] of [...this.streams]) {
      if (!key.startsWith(`${hostId}:`)) continue
      this.streams.delete(key)
      answer(errorAnswer({ v: RUNTIME_VERSION, id: '' }, 'failed', 'The host is not connected.'))
    }
  }

  /** A host's `artifacts.runtime` event: one event of a stream main opened. */
  streamed(hostId: string, event: unknown): void {
    const { stream, answer } = (event ?? {}) as { stream?: unknown; answer?: unknown }
    if (typeof stream !== 'string' || !isAnswer(answer)) return
    this.streams.get(`${hostId}:${stream}`)?.(answer)
  }

  /**
   * Passes a page's message to the host, whose answers go to `answer`: one, or a stream's events
   * and then its end. Returns the cancel, which ends a stream.
   */
  runtime(
    hostId: string,
    id: string,
    message: unknown,
    answer: (answer: RuntimeAnswer) => void,
  ): () => void {
    const header = messageHeader(message)
    const kind = (message as { kind?: unknown } | null)?.kind
    const stream = kind === 'stream' ? `main:${this.nextStream++}` : undefined
    const key = `${hostId}:${stream}`
    let done = false
    if (stream) {
      this.streams.set(key, (next) => {
        if (done) return
        // An event of the stream, or its end when the host's session did.
        if ('event' in next) return answer(next)
        done = true
        answer({ ...next, ...header })
      })
    }
    const finish = (last: RuntimeAnswer): void => {
      if (done) return
      done = true
      if (stream) this.streams.delete(key)
      answer(last)
    }
    this.send(hostId, id, message, stream).then(finish, (error: unknown) => {
      log.warn(`Host ${hostId} did not answer a page of ${id}: ${String(codeOf(error))}`)
      finish(errorAnswer(header, 'failed', 'The host did not answer.'))
    })
    return () => {
      if (done) return
      done = true
      if (!stream) return
      this.streams.delete(key)
      const cancel = { v: header.v, id: header.id, kind: 'cancel' }
      void this.send(hostId, id, cancel, stream).catch(() => {})
    }
  }

  /** A typed version converted on its host to one of its type's formats. */
  async exportVersion(
    hostId: string,
    id: string,
    version: number,
    format: ArtifactExportFormat,
  ): Promise<ArtifactExportResult> {
    let result: unknown
    try {
      result = await this.deps.call(hostId, 'artifacts.export', { id, version, format })
    } catch (error) {
      if (codeOf(error) === 'not_found') return { kind: 'not_found' }
      const message = (error as { message?: unknown } | null)?.message
      return { kind: 'failed', message: typeof message === 'string' ? message : 'Export failed' }
    }
    const { title, files } = (result ?? {}) as { title?: unknown; files?: unknown }
    const failed: ArtifactExportResult = { kind: 'failed', message: 'The host sent no files' }
    if (typeof title !== 'string' || title.length > MAX_TITLE) return failed
    if (!Array.isArray(files) || files.length < 1 || files.length > VERSION_FILES) return failed
    const exported: ExportedFile[] = []
    for (const file of files as unknown[]) {
      const name = (file as { path?: unknown } | null)?.path
      const bytes = bytesOf(file)
      if (typeof name !== 'string' || artifactPathProblem(name) !== null || !bytes) return failed
      exported.push({ path: name, bytes })
    }
    return { kind: 'exported', title, files: exported }
  }

  private async read(
    hostId: string,
    id: string,
    version: number | null,
  ): Promise<ArtifactContentResult> {
    try {
      const params = version === null ? { id } : { id, version }
      const read = parseRead(await this.deps.call(hostId, 'artifacts.read', params))
      if (!read || (version !== null && read.version !== version)) {
        log.warn(`Host ${hostId} sent no version of ${id} that can be shown`)
        return { kind: 'failed' }
      }
      const name = hash(`${hostId}\0${id}\0${read.version}`)
      const folder = path.join(this.deps.dir, name)
      return {
        kind: 'found',
        version: read.version,
        title: read.title,
        // What the host's own key would name: these files, and for a type its format.
        key: hash(`${name}\0${read.type?.name ?? ''}\0${read.type?.format ?? ''}`),
        // The host does not say what the version declares. A page that asks to read beyond itself
        // loses the CDNs then, as the request filter does for any origin.
        strict: false,
        files: read.files.map((file) => ({
          path: file.path,
          file: path.join(folder, hash(file.path).slice(0, 32)),
          size: file.size,
        })),
        type: read.type,
      }
    } catch (error) {
      if (codeOf(error) === 'not_found') return { kind: 'not_found' }
      log.warn(`Could not read ${id} from host ${hostId}: ${String(codeOf(error) ?? error)}`)
      return { kind: 'failed' }
    }
  }

  /** Fetches one file of a version where its list places it, unless it is there already. */
  private fetchFile(
    hostId: string,
    id: string,
    version: number,
    file: ArtifactContentFile,
  ): Promise<void> {
    let pending = this.fetching.get(file.file)
    if (pending) return pending
    pending = (async () => {
      if (await exists(file.file)) return
      const bytes = bytesOf(
        await this.deps.call(hostId, 'artifacts.file', { id, version, path: file.path }),
      )
      if (!bytes) throw new Error(`The host sent no bytes for ${file.path}`)
      if (bytes.byteLength > VERSION_BYTES) {
        throw new Error('The file is larger than a version may be')
      }
      await mkdir(path.dirname(file.file), { recursive: true })
      // Written whole under another name first, so a run that ends meanwhile leaves no part of it.
      const part = `${file.file}.${++this.parts}${PART}`
      await writeFile(part, bytes)
      await rename(part, file.file)
      this.schedulePrune()
    })()
    this.fetching.set(file.file, pending)
    const done = (): void => {
      this.fetching.delete(file.file)
    }
    pending.then(done, done)
    return pending
  }

  /** Marks a version's folder used now, which keeps it from the next prune longer. */
  private async touch(folder: string): Promise<void> {
    const now = Date.now()
    if (now - (this.touched.get(folder) ?? 0) < TOUCH_MS) return
    this.touched.set(folder, now)
    const at = new Date(now)
    await utimes(folder, at, at).catch(() => {})
  }

  private schedulePrune(): void {
    if (this.pruneTimer) return
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null
      this.prune().catch((error: unknown) => {
        log.warn(`Could not keep the files of other hosts within their size: ${String(error)}`)
      })
    }, PRUNE_DELAY_MS)
    this.pruneTimer.unref()
  }

  private async send(
    hostId: string,
    id: string,
    message: unknown,
    stream: string | undefined,
    again = false,
  ): Promise<RuntimeAnswer> {
    const key = artifactRef(hostId, id)
    let frame = this.frames.get(key)
    if (!frame) {
      frame = this.deps.call(hostId, 'artifacts.openFrame', { id }).then((result) => {
        const opened = (result as { path?: unknown } | null)?.path
        if (typeof opened !== 'string' || !FRAME_PATH.test(opened)) {
          throw new Error('The host named no frame')
        }
        return opened
      })
      this.frames.set(key, frame)
      frame.catch(() => {
        if (this.frames.get(key) === frame) this.frames.delete(key)
      })
    }
    const opened = await frame
    try {
      const answer = await this.deps.call(hostId, 'artifacts.frameRuntime', {
        path: opened,
        message,
        ...(stream === undefined ? {} : { stream }),
      })
      if (!isAnswer(answer)) throw new Error('The host sent no answer')
      return answer
    } catch (error) {
      // The host closes a session's oldest frames as it opens more: this one is opened again.
      if (again || codeOf(error) !== 'not_found') throw error
      if (this.frames.get(key) === frame) this.frames.delete(key)
      return this.send(hostId, id, message, stream, true)
    }
  }
}
