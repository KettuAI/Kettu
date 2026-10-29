// The `kettu-artifact` protocol: each artifact on an origin of its own, its HTML from the
// store and nothing else.

import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { CustomScheme, Session } from 'electron'
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

export interface ArtifactRequest {
  id: string
  /** Null for the latest. */
  version: number | null
  /** One page of a canvas alone: its group, 0 outside any, and its place in it, both from 1. */
  page: { group: number; index: number } | null
}

const VERSION = /^[1-9][0-9]{0,8}$/
const PAGE = /^(0|[1-9][0-9]{0,3})\.([1-9][0-9]{0,3})$/

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
  const versions = parsed.searchParams.getAll('v')
  const pages = parsed.searchParams.getAll('page')
  if (versions.length > 1 || pages.length > 1) return null
  const [v] = versions
  const [p] = pages
  if (v !== undefined && !VERSION.test(v)) return null
  const page = p === undefined ? null : PAGE.exec(p)
  if (p !== undefined && !page) return null
  return {
    id,
    version: v === undefined ? null : Number(v),
    page: page ? { group: Number(page[1]), index: Number(page[2]) } : null,
  }
}

/** The style that shows one page of a canvas alone, at the top left; built from checked integers. */
export function pageStyle(group: number, index: number): string {
  const page = `:nth-child(${index} of [data-page])`
  const reset = 'html,body{margin:0!important;padding:0!important}'
  if (group === 0) {
    return `${reset}body>:not(${page}){display:none!important}body>${page}{margin:0!important}`
  }
  const row = `:nth-child(${group} of [data-page-group])`
  return (
    `${reset}body>:not(${row}){display:none!important}body>${row}{display:contents!important}` +
    `body>${row}>:not(${page}){display:none!important}body>${row}>${page}{margin:0!important}`
  )
}

/** The HTML with a style element at the end of its head, or where the parser would put one. */
export function withStyle(html: string, css: string): string {
  const style = `<style>${css}</style>`
  let at = html.search(/<\/head\s*>/i)
  if (at < 0) at = html.search(/<body[\s>]/i)
  if (at < 0) at = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0
  return html.slice(0, at) + style + html.slice(at)
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
