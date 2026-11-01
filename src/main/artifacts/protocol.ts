// The `kettu-artifact` protocol: each artifact on an origin of its own, its HTML from the
// store and nothing else.

import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { CustomScheme, Session } from 'electron'
import { pageStyle, parseArtifactQuery, withStyle, type ArtifactQuery } from '@shared/artifact-page'
import type { ArtifactContentResult } from '@shared/host-control'
import { createLogger } from '../log'
import { ARTIFACT_SCHEME, artifactHost } from './origins'
import { artifactHeaders } from './policy'

const log = createLogger('artifacts')

/**
 * How long a request waits for the host to name a version's file before it answers 503. Well inside
 * the frame guard's commit timeout, since a frame still waiting then cuts the window off.
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
  /** `artifacts/content/` in the data folder, where every version's file lies. */
  contentDir: string
  /** The artifact on this origin id, when it was opened in this run. */
  artifactOf(host: string): string | undefined
  content(id: string, version: number | null): Promise<ArtifactContentResult>
}

export interface ArtifactRequest extends ArtifactQuery {
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
  if (parsed.pathname !== '/' && parsed.pathname !== '/index.html') return null
  const query = parseArtifactQuery(parsed.searchParams)
  return query ? { id, ...query } : null
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

/** Answers one request on an artifact origin. */
function withinWait(content: Promise<ArtifactContentResult>): Promise<ArtifactContentResult> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<ArtifactContentResult>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`The agent host named no file within ${CONTENT_WAIT_MS} ms`)
      resolve({ kind: 'failed' })
    }, CONTENT_WAIT_MS)
  })
  return Promise.race([content, late]).finally(() => clearTimeout(timer))
}

export async function respond(request: Request, source: ArtifactSource): Promise<Response> {
  if (request.method !== 'GET') return answer(405)
  const wanted = parseRequest(request.url, (host) => source.artifactOf(host))
  if (!wanted) return answer(404)
  const found = await withinWait(source.content(wanted.id, wanted.version))
  if (found.kind === 'not_found') return answer(404)
  if (found.kind === 'failed') return answer(503)
  if (!isInside(source.contentDir, found.path)) {
    log.error(`Refused ${wanted.id}'s file outside the content folder: ${found.path}`)
    return answer(404)
  }
  try {
    if (wanted.page) {
      const html = await readFile(found.path, 'utf8')
      const css = pageStyle(wanted.page.group, wanted.page.index)
      return new Response(withStyle(html, css), { headers: artifactHeaders() })
    }
    const file = await open(found.path, 'r')
    const body = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>
    return new Response(body, { headers: artifactHeaders() })
  } catch (error) {
    log.error(`Could not read ${wanted.id} version ${found.version}`, error)
    return answer(404)
  }
}

/** Serves artifacts through the session's `kettu-artifact` protocol. */
export function serveArtifacts(session: Session, source: ArtifactSource): void {
  session.protocol.handle(ARTIFACT_SCHEME, (request) => respond(request, source))
}
