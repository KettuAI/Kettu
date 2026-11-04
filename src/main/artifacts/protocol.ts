// The `kettu-artifact` protocol: each artifact on an origin of its own, the files of its versions
// from the store and nothing else.

import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { CustomScheme, Session } from 'electron'
import { artifactFileType, isHtmlPath } from '@shared/artifact-files'
import { parseServed, servedHtml, type ServedFile } from '@shared/artifact-page'
import {
  MESSAGE_BYTES,
  noCapability,
  parsePageMessage,
  received,
  RUNTIME_PATH,
  RUNTIME_VERSION,
  type RuntimeAnswer,
  type SelectMessage,
} from '@shared/artifact-runtime/page-messages'
import type { ArtifactContentResult } from '@shared/host-control'
import { createLogger } from '../log'
import { ARTIFACT_SCHEME, artifactHost } from './origins'
import { artifactHeaders } from './policy'

const log = createLogger('artifacts')

/**
 * How long a request waits for the host to name a version's files before it answers 503. Well
 * inside the frame guard's commit timeout, since a frame still waiting then cuts the window off.
 */
export const CONTENT_WAIT_MS = 2_000

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
  /** The artifact on this origin id, when it was opened in this run. */
  artifactOf(host: string): string | undefined
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  /** A page on this origin id reported a pick, checked; null where no window takes them. */
  selected: ((host: string, message: SelectMessage) => void) | null
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

function withinWait(content: Promise<ArtifactContentResult>): Promise<ArtifactContentResult> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<ArtifactContentResult>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`The agent host named no files within ${CONTENT_WAIT_MS} ms`)
      resolve({ kind: 'failed' })
    }, CONTENT_WAIT_MS)
  })
  return Promise.race([content, late]).finally(() => clearTimeout(timer))
}

function json(status: number, body: RuntimeAnswer): Response {
  const headers = { ...artifactHeaders(), 'Content-Type': 'application/json; charset=utf-8' }
  return new Response(JSON.stringify(body), { status, headers })
}

/** The body's text, or null when it is longer than `limit` bytes. */
async function cappedText(request: Request, limit: number): Promise<string | null> {
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > limit || !request.body) return length > limit ? null : ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      void reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A message from the page runtime on an artifact origin: a pick goes to the windows that opened
 * the origin; a capability's gets the answer of a client that offers none.
 */
async function runtimeMessage(request: Request, source: ArtifactSource): Promise<Response> {
  const host = artifactHost(request.url)
  if (!host || !source.artifactOf(host)) return answer(404)
  if (request.method !== 'POST') return answer(405)
  const invalid = (message: string): Response =>
    json(400, { v: RUNTIME_VERSION, id: '', ok: false, error: { code: 'invalid', message } })
  const text = await cappedText(request, MESSAGE_BYTES)
  if (text === null) return invalid('The message is too large')
  let parsed: ReturnType<typeof parsePageMessage> = null
  try {
    parsed = parsePageMessage(JSON.parse(text))
  } catch {
    // Not JSON; refused below.
  }
  if (!parsed) return invalid('Not a page runtime message')
  if (parsed.kind === 'select') {
    source.selected?.(host, parsed.message)
    return json(200, received(parsed.message.id))
  }
  return json(200, noCapability(parsed.message))
}

/** Answers one request on an artifact origin: a file of the version it names, or of the latest. */
export async function respond(request: Request, source: ArtifactSource): Promise<Response> {
  if (URL.parse(request.url)?.pathname === RUNTIME_PATH) return runtimeMessage(request, source)
  if (request.method !== 'GET') return answer(405)
  const wanted = parseRequest(request.url, (host) => source.artifactOf(host))
  if (!wanted) return answer(404)
  const found = await withinWait(source.content(wanted.id, wanted.version))
  if (found.kind === 'not_found') return answer(404)
  if (found.kind === 'failed') return answer(503)
  const file = found.files.find((f) => f.path === wanted.path)
  if (!file) return answer(404)
  if (!isInside(source.contentDir, file.file)) {
    log.error(`Refused ${wanted.id}'s file outside the content folder: ${file.file}`)
    return answer(404)
  }
  const headers = { ...artifactHeaders(), 'Content-Type': artifactFileType(file.path) }
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

/** Serves artifacts through the session's `kettu-artifact` protocol. */
export function serveArtifacts(session: Session, source: ArtifactSource): void {
  session.protocol.handle(ARTIFACT_SCHEME, (request) => respond(request, source))
}
