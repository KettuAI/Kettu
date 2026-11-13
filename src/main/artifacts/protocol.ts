// The `kettu-artifact` protocol: each artifact on an origin of its own, the files of its versions
// from the store and nothing else.

import { createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { CustomScheme, Session } from 'electron'
import { ARTIFACT_ENTRY, artifactFileType, isHtmlPath } from '@shared/artifact-files'
import { parseServed, servedHtml, type ServedFile } from '@shared/artifact-page'
import { errorAnswer, type RuntimeAnswer } from '@shared/artifact-capabilities'
import {
  MESSAGE_BYTES,
  parsePageMessage,
  received,
  type SelectMessage,
} from '@shared/artifact-runtime/page-messages'
import { VIEWER_PREFIX, viewerBase, viewerPage } from '@shared/artifact-types'
import { parseArtifactRef } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import type { Locale } from '@shared/locale'
import { createLogger } from '../log'
import { ARTIFACT_SCHEME, artifactHost } from './origins'
import { artifactHeaders } from './policy'
import { isRuntimeRequest, respondRuntime, type RuntimeRelay } from './runtime'
import type { ViewerFiles } from './viewers'

const log = createLogger('artifacts')

/**
 * How long a request waits for the host to name a version's files before it answers 503. Well
 * inside the frame guard's commit timeout, since a frame still waiting then cuts the window off.
 */
export const CONTENT_WAIT_MS = 2_000

/** The same wait for an artifact of another host, and for each of its files main fetches. */
export const REMOTE_CONTENT_WAIT_MS = 30_000

/** A standard scheme gives each host its own origin and storage. */
export const artifactScheme: CustomScheme = {
  scheme: ARTIFACT_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}

export interface ArtifactSource {
  /** `artifacts/content/` in the data folder, where the bytes of every file lie. */
  contentDir: string
  /** Where the files main fetched from other hosts lie, when it shows their artifacts. */
  remoteDir?: string
  /** The artifact on this origin id, when it was opened in this run. */
  artifactOf(host: string): string | undefined
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  /**
   * Puts the files of a version that `paths` names, every one when null, where its answer to
   * `content` places them; only another host's are fetched then.
   */
  ready?(id: string, version: number, paths: readonly string[] | null): Promise<void>
  /** A page on this origin id reported a pick, checked; null where no window takes them. */
  selected: ((host: string, message: SelectMessage) => void) | null
  /** Where a page's capability requests go; none, as for thumbnails, offers no capability. */
  runtime?: RuntimeRelay | null
  /** What the latest version declares makes the artifact's pages strict, or no longer. */
  declared?(id: string, strict: boolean): void
  /** The type viewers' files, which a typed artifact's origin serves. */
  viewers?: ViewerFiles
  /** The interface language, which a type's viewer speaks. */
  locale?: () => Locale
}

export interface ArtifactRequest extends ServedFile {
  id: string
}

/** What a URL on an artifact origin asks for, or null for anything the protocol does not serve. */
export function parseRequest(
  url: string,
  artifactOf: (host: string) => string | undefined,
): ArtifactRequest | null {
  const host = artifactHost(url)
  const parsed = URL.parse(url)
  const id = host ? artifactOf(host) : undefined
  if (!parsed || !id) return null
  const served = parseServed(parsed.pathname, parsed.searchParams)
  return served ? { id, ...served } : null
}

/** Whether `file` lies inside `dir`, by its path as written. */
export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(dir, path.resolve(file))
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function answer(status: number): Response {
  const headers = { ...artifactHeaders(), 'Content-Type': 'text/plain; charset=utf-8' }
  return new Response(status === 404 ? 'Not found' : null, { status, headers })
}

/**
 * Whether `file` lies where the files of the artifact `id` are kept: this computer's in the
 * content folder, another host's in the folder main fetched them into.
 */
export function isStored(
  source: Pick<ArtifactSource, 'contentDir' | 'remoteDir'>,
  id: string,
  file: string,
): boolean {
  if (parseArtifactRef(id)?.hostId == null) return isInside(source.contentDir, file)
  return source.remoteDir !== undefined && isInside(source.remoteDir, file)
}

function withinWait<T>(waited: Promise<T>, ms: number, late: T, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const giveUp = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`The host ${what} within ${ms} ms`)
      resolve(late)
    }, ms)
  })
  return Promise.race([waited, giveUp]).finally(() => clearTimeout(timer))
}

function json(status: number, body: RuntimeAnswer): Response {
  const headers = { ...artifactHeaders(true), 'Content-Type': 'application/json; charset=utf-8' }
  return new Response(JSON.stringify(body), { status, headers })
}

/** A page's message for the editor rather than a capability: a pick, for the windows of `host`. */
function editorMessage(
  host: string,
  source: ArtifactSource,
  message: unknown,
  bytes: number,
): Response {
  const parsed = bytes > MESSAGE_BYTES ? null : parsePageMessage(message)
  if (parsed?.kind !== 'select') {
    return json(400, errorAnswer({ v: 1, id: '' }, 'invalid', 'Not a page runtime message.'))
  }
  source.selected?.(host, parsed.message)
  return json(200, received(parsed.message.id))
}

/**
 * A page's request to the runtime, from its own origin; one that another origin sends, as only
 * the app's own page could, is refused.
 */
function runtimeRequest(request: Request, source: ArtifactSource): Promise<Response> | Response {
  const host = artifactHost(request.url)
  const id = host ? source.artifactOf(host) : undefined
  const origin = request.headers.get('origin')
  if (!host || !id || (origin !== null && artifactHost(origin) !== host)) return answer(404)
  return respondRuntime(request, id, source.runtime ?? null, (message, bytes) =>
    editorMessage(host, source, message, bytes),
  )
}

/** Answers one request on an artifact origin: a file of the version it names, or of the latest. */
export async function respond(request: Request, source: ArtifactSource): Promise<Response> {
  if (isRuntimeRequest(request.url)) return runtimeRequest(request, source)
  if (request.method !== 'GET') return answer(405)
  const wanted = parseRequest(request.url, (host) => source.artifactOf(host))
  if (!wanted) return answer(404)
  const remote = parseArtifactRef(wanted.id)?.hostId != null
  const wait = remote ? REMOTE_CONTENT_WAIT_MS : CONTENT_WAIT_MS
  const found = await withinWait<ArtifactContentResult>(
    source.content(wanted.id, wanted.version),
    wait,
    { kind: 'failed' },
    'named no files',
  )
  if (found.kind === 'not_found') return answer(404)
  if (found.kind === 'failed') return answer(503)
  if (found.type) {
    // A typed artifact's page is its type's viewer, which reads the content files beside it.
    if (wanted.path === ARTIFACT_ENTRY) {
      const page = viewerPage(
        found.type,
        found.version,
        source.locale?.() ?? 'en',
        viewerBase(wanted.version),
      )
      if (!page) return answer(404)
      const headers = { ...artifactHeaders(), 'Content-Type': artifactFileType(ARTIFACT_ENTRY) }
      const html = servedHtml(page, null, { path: ARTIFACT_ENTRY, transport: 'fetch' })
      return new Response(html, { headers })
    }
    if (wanted.path.startsWith(VIEWER_PREFIX)) {
      const file = await source.viewers?.find(wanted.path.slice(VIEWER_PREFIX.length))
      if (!file) return answer(404)
      return streamed(file, artifactFileType(wanted.path))
    }
  }
  const file = found.files.find((f) => f.path === wanted.path)
  if (!file) return answer(404)
  if (!isStored(source, wanted.id, file.file)) {
    log.error(`Refused ${wanted.id}'s file outside the content folder: ${file.file}`)
    return answer(404)
  }
  if (source.ready) {
    const ready = await withinWait(
      source.ready(wanted.id, found.version, [file.path]).then(
        () => true,
        (error: unknown) => {
          log.warn(`Could not fetch ${file.path} of ${wanted.id}: ${String(error)}`)
          return false
        },
      ),
      wait,
      false,
      'sent no file',
    )
    if (!ready) return answer(503)
  }
  source.declared?.(wanted.id, found.strict)
  const headers = { ...artifactHeaders(found.strict), 'Content-Type': artifactFileType(file.path) }
  try {
    if (isHtmlPath(file.path)) {
      const html = servedHtml(await readFile(file.file, 'utf8'), wanted.page, {
        path: file.path,
        transport: 'fetch',
      })
      return new Response(html, { headers })
    }
    const handle = await open(file.file, 'r')
    const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
    return new Response(body, { headers })
  } catch (error) {
    log.error(`Could not read ${file.path} of ${wanted.id} version ${found.version}`, error)
    return answer(404)
  }
}

/** A viewer file. It lies in the app's archive, which a read stream reads in place. */
function streamed(file: string, type: string): Response {
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>
  return new Response(body, { headers: { ...artifactHeaders(), 'Content-Type': type } })
}

/** Serves artifacts through the session's `kettu-artifact` protocol. */
export function serveArtifacts(session: Session, source: ArtifactSource): void {
  session.protocol.handle(ARTIFACT_SCHEME, (request) => respond(request, source))
}
