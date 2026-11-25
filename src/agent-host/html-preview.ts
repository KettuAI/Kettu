// A session's HTML files served read-only on the loopback address, so Kettu's browser shows a page
// with the styles, scripts and pictures it loads while `file:` stays closed to it.

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { artifactFileType } from '@shared/artifact-files'
import type { Platform } from '@shared/platform'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
import { pathKey } from './paths'

export interface HtmlPreviewsDeps {
  platform: Platform
  /** The folder a session works in; null for one that is gone or archived. */
  folderOf(sessionId: string): string | null
  log(level: 'warn' | 'error', message: string): void
}

const HOST = '127.0.0.1'
const TOKEN_BYTES = 24
const HTML = /\.html?$/i

// No CORS header, so another site's page reads nothing; the token stays out of Referer headers.
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const

/** The path's segments, or null for one that names a dot file, climbs out or is no file name. */
function servedSegments(segments: string[], platform: Platform): string[] | null {
  if (segments.length === 0) return null
  for (const segment of segments) {
    if (segment === '' || segment.startsWith('.') || segment.includes('\0')) return null
    if (segment.includes('/')) return null
    // A backslash separates on Windows, and a colon is a drive or an alternate data stream.
    if (platform === 'win32' && /[\\:]/.test(segment)) return null
  }
  return segments
}

/**
 * Every session gets one random token, and its pages are at `/<token>/<path in its folder>`: only
 * GET and HEAD, no folder listed, nothing outside the folder and no dot file or dot folder, even
 * through a link. The tokens live in memory, so they end with the session or the host.
 */
export class HtmlPreviews {
  private server: http.Server | null = null
  private starting: Promise<number> | null = null
  private port: number | null = null
  private readonly bySession = new Map<string, string>()
  private readonly byToken = new Map<string, string>()

  constructor(private readonly deps: HtmlPreviewsDeps) {}

  /** The address of an HTML file of the session's folder; the server starts on the first. */
  async url(sessionId: string, relativePath: string): Promise<string> {
    const folder = this.deps.folderOf(sessionId)
    if (folder === null) throw notFound(t('session.notFound'))
    const written = relativePath
      .split(this.deps.platform === 'win32' ? /[\\/]/ : '/')
      .filter((segment) => segment !== '' && segment !== '.')
    const segments = servedSegments(written, this.deps.platform)
    if (!segments) throw invalidParams(t('files.previewRefused', { path: relativePath }))
    if (!HTML.test(segments.at(-1)!)) {
      throw invalidParams(t('files.previewNotHtml', { path: relativePath }))
    }
    if (!(await this.resolve(folder, segments))) {
      throw notFound(t('files.notExist', { path: relativePath }))
    }
    const port = await this.start()
    let token = this.bySession.get(sessionId)
    if (!token) {
      token = randomBytes(TOKEN_BYTES).toString('base64url')
      this.bySession.set(sessionId, token)
      this.byToken.set(token, sessionId)
    }
    return `http://${HOST}:${port}/${token}/${segments.map(encodeURIComponent).join('/')}`
  }

  /** Sessions archived or deleted: their pages are refused from now on. */
  end(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.forget(sessionId)
  }

  /** Stops listening; every token ends with it. */
  async stop(): Promise<void> {
    const server = this.server
    const starting = this.starting
    this.server = null
    this.starting = null
    this.port = null
    this.bySession.clear()
    this.byToken.clear()
    if (!server) return
    await starting?.catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private forget(sessionId: string): void {
    const token = this.bySession.get(sessionId)
    if (token === undefined) return
    this.bySession.delete(sessionId)
    this.byToken.delete(token)
  }

  private start(): Promise<number> {
    if (this.starting) return this.starting
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.deps.log('error', `An HTML preview failed: ${(error as Error).message}`)
        if (!res.headersSent) answer(res, 500)
        else res.destroy()
      })
    })
    this.server = server
    const starting = new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, HOST, () => {
        server.off('error', reject)
        server.on('error', (error) => this.deps.log('warn', `HTML previews: ${error.message}`))
        // The host's own channel keeps its process alive; the server alone must not.
        server.unref()
        this.port = (server.address() as AddressInfo).port
        resolve(this.port)
      })
    })
    this.starting = starting
    starting.catch((error: unknown) => {
      this.deps.log('error', `HTML previews cannot listen: ${(error as Error).message}`)
      if (this.starting === starting) {
        this.starting = null
        this.server = null
      }
    })
    return starting
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...HEADERS, Allow: 'GET, HEAD' }).end()
      return
    }
    // A domain rebound to this address sends its own name; only the address itself is served.
    if (this.port === null || req.headers.host !== `${HOST}:${this.port}`) return answer(res, 403)
    const target = (req.url ?? '').split('?')[0]!
    if (!target.startsWith('/')) return answer(res, 404)
    const [token = '', ...rest] = target.slice(1).split('/')
    const sessionId = this.byToken.get(token)
    if (sessionId === undefined) return answer(res, 404)
    const folder = this.deps.folderOf(sessionId)
    if (folder === null) {
      this.forget(sessionId)
      return answer(res, 404)
    }
    let decoded: string[]
    try {
      decoded = rest.map((segment) => decodeURIComponent(segment))
    } catch {
      return answer(res, 404)
    }
    const segments = servedSegments(decoded, this.deps.platform)
    const file = segments && (await this.resolve(folder, segments))
    if (!file) return answer(res, 404)
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': artifactFileType(file.real.replace(/\\/g, '/')),
      'Content-Length': String(file.size),
    })
    if (req.method === 'HEAD' || file.size === 0) {
      res.end()
      return
    }
    // Only the bytes counted, should the file grow while it is read.
    const stream = createReadStream(file.real, { start: 0, end: file.size - 1 })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  /**
   * The regular file at `segments` in the folder, by its real path, which must stay inside the
   * folder and name no dot file or dot folder once links are followed; null otherwise.
   */
  private async resolve(
    folder: string,
    segments: string[],
  ): Promise<{ real: string; size: number } | null> {
    const { platform } = this.deps
    const paths = platform === 'win32' ? path.win32 : path.posix
    let root: string
    let real: string
    try {
      root = await realpath(folder)
      real = await realpath(paths.join(root, ...segments))
    } catch {
      return null
    }
    const rootKey = pathKey(root, platform)
    const prefix = rootKey.endsWith(paths.sep) ? rootKey : rootKey + paths.sep
    if (!pathKey(real, platform).startsWith(prefix)) return null
    if (
      paths
        .relative(root, real)
        .split(paths.sep)
        .some((segment) => segment.startsWith('.'))
    ) {
      return null
    }
    const info = await stat(real).catch(() => null)
    return info?.isFile() ? { real, size: info.size } : null
  }
}

function answer(res: http.ServerResponse, status: number): void {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(http.STATUS_CODES[status] ?? '')
}
