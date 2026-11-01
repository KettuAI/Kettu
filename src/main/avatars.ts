// Pull request authors' and the Kettu account's avatars. The CSP blocks remote images, so main
// fetches each picture from the avatar hosts alone and hands it to the renderer as a data: URL.

import { createLogger, describeError } from './log'
import { readBody } from './theme-catalog'

const log = createLogger('avatars')

const AVATAR_HOST = 'avatars.githubusercontent.com'
// The card draws a 20 px avatar, so 64 px is sharp at 3x.
const AVATAR_SIZE = '64'
const MAX_BYTES = 100 * 1024
const CACHE_SIZE = 200
const TIMEOUT_MS = 15_000
const TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type AvatarFetch = (url: string, init: RequestInit) => Promise<Response>

/** What main fetches for an avatar URL, at 64 px; null when it is not on GitHub's avatar host. */
export function avatarRequestUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.host !== AVATAR_HOST || url.username || url.password) {
    return null
  }
  url.searchParams.set('s', AVATAR_SIZE)
  return url.href
}

// Where GitHub and Google keep the pictures of the identities a Kettu account signs in with.
const GOOGLE_AVATAR_HOST = /^lh[3-6]\.googleusercontent\.com$/
// The account row draws a 30 px avatar.
const ACCOUNT_AVATAR_SIZE = '96'

/** What main fetches for a Kettu account's avatar; null when it is not on GitHub's or Google's host. */
export function accountAvatarRequestUrl(raw: string): string | null {
  const github = avatarRequestUrl(raw)
  if (github) {
    const url = new URL(github)
    url.searchParams.set('s', ACCOUNT_AVATAR_SIZE)
    return url.href
  }
  const url = URL.parse(raw)
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null
  return GOOGLE_AVATAR_HOST.test(url.host) ? url.href : null
}

export class Avatars {
  private readonly pictures = new Map<string, string>()
  private readonly loads = new Map<string, Promise<string | null>>()

  constructor(
    private readonly fetch: AvatarFetch,
    private readonly requestUrl: (raw: string) => string | null = avatarRequestUrl,
  ) {}

  /** The picture at an avatar URL as a data: URL; null when it is none or did not load. */
  load(raw: string): Promise<string | null> {
    const url = this.requestUrl(raw)
    if (!url) return Promise.resolve(null)
    const picture = this.pictures.get(url)
    if (picture) return Promise.resolve(picture)
    let load = this.loads.get(url)
    if (!load) {
      load = this.read(url).finally(() => this.loads.delete(url))
      this.loads.set(url, load)
    }
    return load
  }

  private async read(url: string): Promise<string | null> {
    try {
      const response = await this.fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!response.ok || !TYPES.has(type)) {
        void response.body?.cancel()
        log.warn(`${url} answered ${response.status} ${type || 'without a type'}`)
        return null
      }
      const bytes = await readBody(response, MAX_BYTES)
      if (!bytes) {
        log.warn(`${url} is larger than ${MAX_BYTES} bytes`)
        return null
      }
      const picture = `data:${type};base64,${bytes.toString('base64')}`
      this.pictures.set(url, picture)
      while (this.pictures.size > CACHE_SIZE) {
        const oldest = this.pictures.keys().next().value
        if (oldest === undefined) break
        this.pictures.delete(oldest)
      }
      return picture
    } catch (error) {
      log.warn(`Could not read ${url}: ${describeError(error)}`)
      return null
    }
  }
}
