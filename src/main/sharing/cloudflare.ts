// Cloudflare as a target: each page is a Worker of its own with Workers Static Assets, uploaded
// through Cloudflare's REST API with the user's API token and served on the account's
// workers.dev subdomain.

import { createHash, randomBytes } from 'node:crypto'
import { headersFile } from './page'
import { SharingError, type Published, type SharingProvider } from './provider'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/** The runtime behavior the Worker targets; its one-line module needs nothing newer. */
export const COMPATIBILITY_DATE = '2026-10-01'

/** Hands every request to the assets, so the upload never relies on an assets-only Worker. */
export const WORKER_MODULE =
  'export default { fetch: (request, env) => env.ASSETS.fetch(request) }\n'

/** A DNS label, as a workers.dev subdomain must be. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** Errors that mean the token is invalid, expired, or has no access to the account. */
const AUTH_CODES = new Set([1000, 9106, 9109, 10000])
const NOT_FOUND = 10007
const TOO_MANY_WORKERS = 10037

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface CloudflareDeps {
  accountId: string
  /** The account's workers.dev subdomain. */
  subdomain: string
  token: string
  fetch: Fetch
  random?: (size: number) => Buffer
}

interface Envelope<T> {
  success?: unknown
  errors?: unknown
  result?: T
  result_info?: { total_pages?: unknown } | null
}

interface Asset {
  path: string
  base64: string
  size: number
  type: string
  hash: string
}

/** `ob-` and 16 random base32 characters, never derived from the artifact. */
export function workerName(random: (size: number) => Buffer = randomBytes): string {
  let name = 'ob-'
  let value = 0
  let bits = 0
  for (const byte of random(10)) {
    value = ((value << 8) | byte) & 0xfff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      name += BASE32[(value >> bits) & 31]
    }
  }
  return name
}

/** A manifest's hash, as Cloudflare's direct upload makes it: of the base64 and the extension. */
export function assetHash(base64: string, extension: string): string {
  return createHash('sha256')
    .update(base64 + extension)
    .digest('hex')
    .slice(0, 32)
}

function asset(path: string, text: string, type: string): Asset {
  const bytes = Buffer.from(text, 'utf8')
  const base64 = bytes.toString('base64')
  const extension = /\.([^./]+)$/.exec(path)?.[1] ?? ''
  return { path, base64, size: bytes.length, type, hash: assetHash(base64, extension) }
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function errorOf(status: number, body: Envelope<unknown> | null): SharingError {
  const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]) : []
  const codes: number[] = []
  const messages: string[] = []
  for (const error of errors) {
    if (typeof error !== 'object' || error === null) continue
    const { code, message } = error as Record<string, unknown>
    if (typeof code === 'number') codes.push(code)
    if (typeof message === 'string' && message) messages.push(message)
  }
  const detail = messages.length > 0 ? messages.join('; ') : null
  const message = `Cloudflare answered ${status}${detail ? `: ${detail}` : ''}`
  if (codes.includes(TOO_MANY_WORKERS)) return new SharingError('worker_limit', message, detail)
  if (status === 401 || status === 403 || codes.some((code) => AUTH_CODES.has(code))) {
    return new SharingError('invalid_token', message, detail)
  }
  if (status === 404 || codes.includes(NOT_FOUND)) {
    return new SharingError('not_found', message, detail)
  }
  return new SharingError('failed', message, detail)
}

async function send<T>(
  fetch: Fetch,
  token: string,
  path: string,
  init: RequestInit,
): Promise<Envelope<T>> {
  let response: Response
  try {
    response = await fetch(`${CLOUDFLARE_API}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    })
  } catch (error) {
    throw new SharingError('network', `Could not reach Cloudflare: ${(error as Error).message}`)
  }
  let body: Envelope<T> | null
  try {
    body = (await response.json()) as Envelope<T>
  } catch {
    body = null
  }
  if (!response.ok || body === null || body.success !== true) throw errorOf(response.status, body)
  return body
}

/** Cloudflare's answer to one call, or the error it stands for. */
async function call<T>(fetch: Fetch, token: string, path: string, init: RequestInit): Promise<T> {
  const { result } = await send<T>(fetch, token, path, init)
  if (result === undefined || result === null) {
    throw new SharingError('failed', `Cloudflare answered ${path} without a result`)
  }
  return result
}

/** Checks a token and account; resolves with the account's workers.dev subdomain. */
export async function verifyAccount(
  fetch: Fetch,
  accountId: string,
  token: string,
): Promise<string> {
  const verified = await call<{ status?: unknown }>(fetch, token, '/user/tokens/verify', {
    method: 'GET',
  })
  if (verified.status !== 'active') {
    throw new SharingError('invalid_token', `The token is ${String(verified.status)}`)
  }
  let found: { subdomain?: unknown }
  try {
    found = await call(fetch, token, `/accounts/${accountId}/workers/subdomain`, { method: 'GET' })
  } catch (error) {
    if (error instanceof SharingError && error.failure === 'not_found') {
      throw new SharingError('no_subdomain', 'The account has no workers.dev subdomain')
    }
    throw error
  }
  const { subdomain } = found
  if (typeof subdomain !== 'string' || subdomain === '') {
    throw new SharingError('no_subdomain', 'The account has no workers.dev subdomain')
  }
  if (!LABEL.test(subdomain)) {
    throw new SharingError(
      'failed',
      `Cloudflare named a subdomain that is no DNS label: ${subdomain}`,
    )
  }
  return subdomain
}

export class Cloudflare implements SharingProvider {
  private readonly scripts: string

  constructor(private readonly deps: CloudflareDeps) {
    this.scripts = `/accounts/${deps.accountId}/workers/scripts`
  }

  async publish(html: string, headers: Record<string, string>): Promise<Published> {
    const worker = workerName(this.deps.random)
    try {
      await this.deploy(worker, html, headers)
      await this.call(
        `${this.scripts}/${worker}/subdomain`,
        json('POST', { enabled: true, previews_enabled: false }),
      )
    } catch (error) {
      // Nothing records the Worker until this resolves, so one half made would be left behind.
      await this.unpublish(worker).catch(() => {})
      throw error
    }
    return { url: `https://${worker}.${this.deps.subdomain}.workers.dev/`, ref: worker }
  }

  update(ref: string, html: string, headers: Record<string, string>): Promise<void> {
    return this.deploy(ref, html, headers)
  }

  async unpublish(ref: string): Promise<void> {
    try {
      await send(this.deps.fetch, this.deps.token, `${this.scripts}/${ref}`, { method: 'DELETE' })
    } catch (error) {
      if (error instanceof SharingError && error.failure === 'not_found') return
      throw error
    }
  }

  async existing(refs: readonly string[]): Promise<Set<string>> {
    const listed = await send<{ id?: unknown }[]>(this.deps.fetch, this.deps.token, this.scripts, {
      method: 'GET',
    })
    const pages = listed.result_info?.total_pages
    // A page of the list would miss Workers that are there.
    if (!Array.isArray(listed.result) || (typeof pages === 'number' && pages > 1)) {
      throw new SharingError('failed', 'Cloudflare listed the Workers in a form not understood')
    }
    const names = new Set(listed.result.map((script) => script?.id))
    return new Set(refs.filter((ref) => names.has(ref)))
  }

  /**
   * The page as the Worker's assets: an upload session for the manifest, the files it asks for,
   * then the script with the assets' completion token and the headers.
   */
  private async deploy(worker: string, html: string, headers: Record<string, string>) {
    const headersText = headersFile(headers)
    const assets = [
      asset('/index.html', html, 'text/html; charset=utf-8'),
      asset('/_headers', headersText, 'text/plain; charset=utf-8'),
    ]
    const manifest = Object.fromEntries(assets.map((a) => [a.path, { hash: a.hash, size: a.size }]))
    const upload = await this.call<{ jwt?: unknown; buckets?: unknown }>(
      `${this.scripts}/${worker}/assets-upload-session`,
      json('POST', { manifest }),
    )
    if (typeof upload.jwt !== 'string') {
      throw new SharingError('failed', 'Cloudflare opened no upload session')
    }
    const buckets = Array.isArray(upload.buckets) ? (upload.buckets as unknown[]) : []
    // With nothing left to upload, the session's token is the completion token already.
    let completion: string | null = buckets.length === 0 ? upload.jwt : null
    for (const bucket of buckets) {
      const form = new FormData()
      for (const hash of Array.isArray(bucket) ? bucket : []) {
        const file = assets.find((a) => a.hash === hash)
        if (!file)
          throw new SharingError('failed', `Cloudflare asked for a file not in the manifest`)
        form.append(file.hash, new Blob([file.base64], { type: file.type }), file.hash)
      }
      // Only the answer to the last bucket carries the completion token.
      const { result } = await send<{ jwt?: unknown } | null>(
        this.deps.fetch,
        upload.jwt,
        `/accounts/${this.deps.accountId}/workers/assets/upload?base64=true`,
        { method: 'POST', body: form },
      )
      if (typeof result?.jwt === 'string') completion = result.jwt
    }
    if (!completion) throw new SharingError('failed', 'Cloudflare did not finish the upload')
    const metadata = {
      main_module: 'index.js',
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [{ name: 'ASSETS', type: 'assets' }],
      assets: { jwt: completion, config: { _headers: headersText } },
    }
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append(
      'index.js',
      new Blob([WORKER_MODULE], { type: 'application/javascript+module' }),
      'index.js',
    )
    await this.call(`${this.scripts}/${worker}`, { method: 'PUT', body: form })
  }

  private call<T>(path: string, init: RequestInit): Promise<T> {
    return call<T>(this.deps.fetch, this.deps.token, path, init)
  }
}
