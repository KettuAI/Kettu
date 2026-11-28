// Non-destructive web client cache refresh and stale-chunk reload handling shared by all web modes
// (Hosted, Relay, and Direct). Never touches IndexedDB (pairing keys and host records),
// localStorage (settings and drafts), cookies (hosted sign-in), or Service Worker registrations
// (Web Push subscriptions).

/** One-time query parameter appended during a cache-busting reload and stripped on startup. */
export const REFRESH_QUERY_PARAM = '_refresh'

/** sessionStorage key guarding stale-chunk auto-reloads against infinite reload loops. */
export const STALE_CHUNK_RELOAD_KEY = 'kettu.reloaded'

/** Upper bound for the best-effort root document revalidation fetch before navigating. */
const DEFAULT_FETCH_TIMEOUT_MS = 3_000

const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Loading chunk [\w-]+ failed/i,
]

export interface RefreshWebCacheDeps {
  caches?: Pick<CacheStorage, 'keys' | 'delete'> | null
  serviceWorker?: {
    getRegistrations?: () => Promise<readonly { update?: () => Promise<unknown> }[]>
  } | null
  fetch?: typeof globalThis.fetch | null
  location?: Pick<Location, 'href' | 'origin' | 'replace'>
  now?: () => number
  fetchTimeoutMs?: number
}

export interface StaleChunkReloadDeps {
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  refresh?: () => Promise<void> | void
}

/**
 * Returns a same-origin URL preserving pathname, existing query params, and hash, with a fresh
 * one-time `_refresh` query parameter to bypass stubborn browser HTML caching.
 */
export function buildCacheBustUrl(currentHref: string, stamp = Date.now()): string {
  const url = new URL(currentHref)
  const previous = url.searchParams.get(REFRESH_QUERY_PARAM)
  const next = String(stamp) === previous ? stamp + 1 : stamp
  url.searchParams.set(REFRESH_QUERY_PARAM, String(next))
  return url.toString()
}

/**
 * Removes the temporary `_refresh` query parameter from the current URL via `history.replaceState`
 * without altering any other query parameters or the hash.
 */
export function stripRefreshQueryParam(
  loc: Pick<Location, 'href'> | undefined = typeof window !== 'undefined'
    ? window.location
    : undefined,
  hist: Pick<History, 'replaceState' | 'state'> | undefined = typeof window !== 'undefined'
    ? window.history
    : undefined,
): boolean {
  if (!loc || !hist) return false
  let url: URL
  try {
    url = new URL(loc.href)
  } catch {
    return false
  }
  if (!url.searchParams.has(REFRESH_QUERY_PARAM)) return false
  url.searchParams.delete(REFRESH_QUERY_PARAM)
  const clean = `${url.pathname}${url.search}${url.hash}`
  try {
    hist.replaceState(hist.state ?? null, '', clean)
    return true
  } catch {
    return false
  }
}

async function clearCacheStorage(cachesApi: RefreshWebCacheDeps['caches']): Promise<void> {
  if (
    !cachesApi ||
    typeof cachesApi.keys !== 'function' ||
    typeof cachesApi.delete !== 'function'
  ) {
    return
  }
  try {
    const keys = await cachesApi.keys()
    await Promise.allSettled(keys.map((key) => cachesApi.delete(key)))
  } catch {
    // Missing or restricted Cache Storage must not block the reload.
  }
}

async function updateServiceWorkers(sw: RefreshWebCacheDeps['serviceWorker']): Promise<void> {
  if (!sw || typeof sw.getRegistrations !== 'function') return
  try {
    const registrations = await sw.getRegistrations()
    await Promise.allSettled(
      registrations.map((registration) =>
        typeof registration.update === 'function' ? registration.update() : Promise.resolve(),
      ),
    )
  } catch {
    // Never unregister Service Workers so existing Web Push subscriptions remain intact.
  }
}

async function revalidateRootDocument(
  origin: string,
  fetchFn: RefreshWebCacheDeps['fetch'],
  timeoutMs: number,
): Promise<void> {
  if (typeof fetchFn !== 'function') return
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    await fetchFn(new URL('/', origin), {
      cache: 'reload',
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch {
    // Offline or timed-out fetches must not block navigating with the cache-busting query.
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Forces the browser to fetch fresh web client assets without clearing IndexedDB, localStorage,
 * cookies, or Service Worker registrations.
 */
export async function refreshWebCache(deps: RefreshWebCacheDeps = {}): Promise<void> {
  const loc = deps.location ?? (typeof window !== 'undefined' ? window.location : undefined)
  if (!loc) return
  const cachesApi =
    deps.caches !== undefined
      ? deps.caches
      : typeof globalThis !== 'undefined' && 'caches' in globalThis
        ? globalThis.caches
        : null
  const sw =
    deps.serviceWorker !== undefined
      ? deps.serviceWorker
      : typeof navigator !== 'undefined'
        ? navigator.serviceWorker
        : null
  const fetchFn =
    deps.fetch !== undefined
      ? deps.fetch
      : typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null
  const now = deps.now ?? Date.now
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS

  await Promise.allSettled([
    clearCacheStorage(cachesApi),
    updateServiceWorkers(sw),
    revalidateRootDocument(loc.origin, fetchFn, timeoutMs),
  ])

  loc.replace(buildCacheBustUrl(loc.href, now()))
}

/** Whether an unhandled rejection reason looks like a stale dynamic module chunk load failure. */
export function isStaleChunkError(reason: unknown): boolean {
  const message =
    typeof reason === 'string'
      ? reason
      : reason &&
          typeof reason === 'object' &&
          'message' in reason &&
          typeof reason.message === 'string'
        ? reason.message
        : ''
  if (!message) return false
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message))
}

function defaultSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

function claimReloadSlot(storage: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  if (!storage) return false
  try {
    if (storage.getItem(STALE_CHUNK_RELOAD_KEY)) return false
    storage.setItem(STALE_CHUNK_RELOAD_KEY, '1')
    return true
  } catch {
    return false
  }
}

/**
 * Registers stale-chunk listeners (`vite:preloadError` and dynamic-import chunk rejections) that
 * trigger a single cache-busted refresh per tab session to recover after a server deploy.
 */
export function reloadOnStaleChunks(deps: StaleChunkReloadDeps = {}): () => void {
  const target = deps.target ?? (typeof window !== 'undefined' ? window : undefined)
  if (!target) return () => {}
  const storage = deps.storage !== undefined ? deps.storage : defaultSessionStorage()
  const refresh = deps.refresh ?? (() => refreshWebCache())

  const handleReload = (event: Event): void => {
    if (!claimReloadSlot(storage)) return
    event.preventDefault()
    void refresh()
  }

  const onPreloadError = (event: Event): void => {
    handleReload(event)
  }

  const onUnhandledRejection = (event: Event): void => {
    const rejection = event as PromiseRejectionEvent
    if (!isStaleChunkError(rejection.reason)) return
    handleReload(event)
  }

  target.addEventListener('vite:preloadError', onPreloadError)
  target.addEventListener('unhandledrejection', onUnhandledRejection)

  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError)
    target.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}

let staleChunkListenerInstalled = false

/** Registers the shared stale-chunk reload listeners at most once per page load. */
export function installStaleChunkReload(): void {
  if (staleChunkListenerInstalled) return
  staleChunkListenerInstalled = true
  reloadOnStaleChunks()
}
