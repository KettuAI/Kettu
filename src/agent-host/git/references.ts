// Keeps the pull requests and issues a window shows current by reading the open ones again.

/** How often an open reference that stays watched is read again. */
export const REFERENCE_REFRESH_MS = 5 * 60_000
/** A reference watched again is read at once when its last read is older than this. */
export const REFERENCE_SHOWN_MS = 60_000
/** The most references one subscriber has watched; the rest are ignored. */
export const MAX_WATCHED_REFERENCES = 60

const TICK_MS = 60_000
const RETRY_MS = 60_000
const RETRY_MAX_MS = 30 * 60_000

export interface ReferenceWatchDeps {
  now: () => number
  /** When a reference was last read and whether it can still change; undefined when never read. */
  cached: (url: string) => { at: number; live: boolean } | undefined
  /** Reads a reference through the host's caches; rejects when gh could not read it. */
  read: (url: string) => Promise<unknown>
}

export interface ReferenceWatcher {
  /** Replaces what a subscriber shows; an empty list releases it. */
  watch(subscriberId: string, urls: readonly string[]): void
  watchers(url: string): string[]
  release(subscriberId: string): void
  stop(): void
}

export function createReferenceWatcher(deps: ReferenceWatchDeps): ReferenceWatcher {
  const subscribers = new Map<string, string[]>()
  const failures = new Map<string, { count: number; retryAt: number }>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let sweeping = false

  function watched(): Set<string> {
    return new Set([...subscribers.values()].flat())
  }

  function isDue(url: string, minAge: number): boolean {
    const failed = failures.get(url)
    if (failed && deps.now() < failed.retryAt) return false
    const entry = deps.cached(url)
    return !entry || (entry.live && deps.now() - entry.at >= minAge)
  }

  function noteFailure(url: string): void {
    const count = (failures.get(url)?.count ?? 0) + 1
    const delay = Math.min(RETRY_MS * 2 ** (count - 1), RETRY_MAX_MS)
    failures.set(url, { count, retryAt: deps.now() + delay })
  }

  // One read at a time, so a long list never opens many gh processes at once.
  async function sweep(minAge: number): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      const urls = watched()
      for (const url of failures.keys()) if (!urls.has(url)) failures.delete(url)
      for (const url of urls) {
        if (subscribers.size === 0) break
        if (!isDue(url, minAge)) continue
        try {
          await deps.read(url)
          failures.delete(url)
        } catch {
          noteFailure(url)
        }
      }
    } finally {
      sweeping = false
    }
  }

  function arm(): void {
    if (timer !== null || subscribers.size === 0) return
    timer = setTimeout(() => {
      timer = null
      void sweep(REFERENCE_REFRESH_MS).then(arm)
    }, TICK_MS)
    timer.unref()
  }

  function stop(): void {
    subscribers.clear()
    failures.clear()
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    watch(subscriberId, urls) {
      const next = [...new Set(urls)].slice(0, MAX_WATCHED_REFERENCES)
      if (next.length === 0) subscribers.delete(subscriberId)
      else subscribers.set(subscriberId, next)
      if (subscribers.size === 0) {
        stop()
        return
      }
      arm()
      void sweep(REFERENCE_SHOWN_MS)
    },
    watchers(url) {
      return [...subscribers].filter(([, urls]) => urls.includes(url)).map(([id]) => id)
    },
    release(subscriberId) {
      if (!subscribers.delete(subscriberId)) return
      if (subscribers.size === 0) stop()
    },
    stop,
  }
}
