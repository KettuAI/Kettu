// Artifacts of the other hosts this computer connects to. Main asks the host for a version's
// files over its session and keeps them in a folder of its own, so the protocol serves them as it
// serves this computer's; a page's capability messages go to the host through a frame it opens
// there, which names the artifact, and the host checks each as it does a paired device's.

import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
const MAX_TITLE = 1_000
const MAX_FORMAT = 1_000
const FRAME_PATH = /^\/frame\/[A-Za-z0-9_-]{43}\/$/

/** A request to a host whose session is open; rejects with the host's error. */
export type HostCall = (hostId: string, method: string, params: unknown) => Promise<unknown>

export interface RemoteArtifactsDeps {
  call: HostCall
  /** The folder the fetched files lie in, which is main's alone. */
  dir: string
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

function isAnswer(value: unknown): value is RuntimeAnswer {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class RemoteArtifacts {
  private readonly cache: ContentCache
  /** Each fetched version's files, by host, artifact and version; a version never changes. */
  private readonly fetched = new Map<string, Promise<ArtifactContentFile[]>>()
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

  /** Removes what an earlier run fetched, since nothing says which of it its host still has. */
  async clear(): Promise<void> {
    await rm(this.deps.dir, { recursive: true, force: true })
  }

  /** The files of a version on the host, the latest when `version` is null, fetched once. */
  content(hostId: string, id: string, version: number | null): Promise<ArtifactContentResult> {
    return this.cache.get(artifactRef(hostId, id), version)
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
      const name = createHash('sha256')
        .update(`${hostId}\0${id}\0${read.version}`, 'utf8')
        .digest('hex')
      let files = this.fetched.get(name)
      if (!files) {
        files = this.fetch(hostId, id, read, path.join(this.deps.dir, name))
        this.fetched.set(name, files)
        files.catch(() => {
          if (this.fetched.get(name) === files) this.fetched.delete(name)
        })
      }
      return {
        kind: 'found',
        version: read.version,
        title: read.title,
        // What the host's own key would name: these files, and for a type its format.
        key: createHash('sha256')
          .update(`${name}\0${read.type?.name ?? ''}\0${read.type?.format ?? ''}`, 'utf8')
          .digest('hex'),
        // The host does not say what the version declares. A page that asks to read beyond itself
        // loses the CDNs then, as the request filter does for any origin.
        strict: false,
        files: await files,
        type: read.type,
      }
    } catch (error) {
      if (codeOf(error) === 'not_found') return { kind: 'not_found' }
      log.warn(`Could not read ${id} from host ${hostId}: ${String(codeOf(error) ?? error)}`)
      return { kind: 'failed' }
    }
  }

  /** Fetches every file of the version into `folder`, each under its place in the list. */
  private async fetch(
    hostId: string,
    id: string,
    read: Read,
    folder: string,
  ): Promise<ArtifactContentFile[]> {
    await mkdir(folder, { recursive: true })
    const files: ArtifactContentFile[] = read.files.map((file, i) => ({
      path: file.path,
      file: path.join(folder, String(i)),
      size: file.size,
    }))
    let next = 0
    let total = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < files.length; i = next++) {
        const file = files[i]!
        const bytes = bytesOf(
          await this.deps.call(hostId, 'artifacts.file', {
            id,
            version: read.version,
            path: file.path,
          }),
        )
        if (!bytes) throw new Error(`The host sent no bytes for ${file.path}`)
        total += bytes.byteLength
        if (total > VERSION_BYTES) throw new Error('The version is larger than a version may be')
        file.size = bytes.byteLength
        await writeFile(file.file, bytes)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker))
    return files
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
