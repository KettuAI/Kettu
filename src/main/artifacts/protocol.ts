// The `kettu-artifact` protocol: each artifact on an origin of its own, the files of its versions
// from the store and nothing else.

import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { CustomScheme, Session } from 'electron'
import { artifactFileType, isHtmlPath } from '@shared/artifact-files'
import { parseServed, servedHtml, type ServedFile } from '@shared/artifact-page'
import type { ArtifactContentResult } from '@shared/host-control'
import { createLogger } from '../log'
import { ARTIFACT_SCHEME, artifactHost } from './origins'
import { artifactHeaders } from './policy'
import { isRuntimeRequest, respondRuntime, type RuntimeRelay } from './runtime'

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
  /** Where a page's capability requests go; none, as for thumbnails, offers no capability. */
  runtime?: RuntimeRelay | null
  /** What the latest version declares makes the artifact's pages strict, or no longer. */
  declared?(id: string, strict: boolean): void
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

/**
 * A page's request to the runtime, from its own origin; one that another origin sends, as only
 * the app's own page could, is refused.
 */
function runtimeRequest(request: Request, source: ArtifactSource): Promise<Response> | Response {
  const host = artifactHost(request.url)
  const id = host ? source.artifactOf(host) : undefined
  const origin = request.headers.get('origin')
  if (!host || !id || (origin !== null && artifactHost(origin) !== host)) return answer(404)
  return respondRuntime(request, id, source.runtime ?? null)
}

/** Answers one request on an artifact origin: a file of the version it names, or of the latest. */
export async function respond(request: Request, source: ArtifactSource): Promise<Response> {
  if (isRuntimeRequest(request.url)) return runtimeRequest(request, source)
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
  source.declared?.(wanted.id, found.strict)
  const headers = { ...artifactHeaders(found.strict), 'Content-Type': artifactFileType(file.path) }
  try {
    if (isHtmlPath(file.path)) {
      const html = servedHtml(await readFile(file.file, 'utf8'), wanted.page)
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
