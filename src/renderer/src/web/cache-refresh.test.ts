import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  buildCacheBustUrl,
  isStaleChunkError,
  REFRESH_QUERY_PARAM,
  refreshWebCache,
  reloadOnStaleChunks,
  STALE_CHUNK_RELOAD_KEY,
  stripRefreshQueryParam,
} from './cache-refresh'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  private readonly map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }
}

describe('buildCacheBustUrl', () => {
  it('preserves pathname, existing query params, and hash while adding _refresh', () => {
    expect(
      buildCacheBustUrl('https://relay.example.com/pair?foo=1&bar=two#token-abc', 1732776000000),
    ).toBe('https://relay.example.com/pair?foo=1&bar=two&_refresh=1732776000000#token-abc')
  })

  it('replaces an existing _refresh param instead of duplicating it', () => {
    expect(buildCacheBustUrl('https://app.kettu.sh/?_refresh=100&view=settings#about', 200)).toBe(
      'https://app.kettu.sh/?_refresh=200&view=settings#about',
    )
  })

  it('bumps the timestamp if it matches the existing _refresh value', () => {
    expect(buildCacheBustUrl('https://app.kettu.sh/?_refresh=500', 500)).toBe(
      'https://app.kettu.sh/?_refresh=501',
    )
  })
})

describe('stripRefreshQueryParam', () => {
  it('removes _refresh while keeping other query params, hash, and history state intact', () => {
    const replaceState = vi.fn()
    const state = { scroll: 42 }
    const changed = stripRefreshQueryParam(
      {
        href: `https://app.kettu.sh/session/123?tab=files&${REFRESH_QUERY_PARAM}=1732776000000#bottom`,
      },
      { replaceState, state },
    )
    expect(changed).toBe(true)
    expect(replaceState).toHaveBeenCalledWith(state, '', '/session/123?tab=files#bottom')
  })

  it('strips the query delimiter cleanly when _refresh was the only parameter', () => {
    const replaceState = vi.fn()
    const changed = stripRefreshQueryParam(
      { href: `https://192.168.1.5:4567/pair?${REFRESH_QUERY_PARAM}=999#code` },
      { replaceState, state: null },
    )
    expect(changed).toBe(true)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/pair#code')
  })

  it('does nothing when _refresh is absent', () => {
    const replaceState = vi.fn()
    const changed = stripRefreshQueryParam(
      { href: 'https://app.kettu.sh/signin/callback?code=abc&state=xyz' },
      { replaceState, state: null },
    )
    expect(changed).toBe(false)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('handles replaceState errors gracefully', () => {
    const replaceState = vi.fn(() => {
      throw new Error('SecurityError')
    })
    const changed = stripRefreshQueryParam(
      { href: `https://app.kettu.sh/?${REFRESH_QUERY_PARAM}=1` },
      { replaceState, state: null },
    )
    expect(changed).toBe(false)
  })
})

describe('refreshWebCache', () => {
  it('clears Cache Storage, updates Service Workers without unregistering, revalidates root, and navigates with _refresh', async () => {
    const deleted: string[] = []
    const cachesApi = {
      keys: vi.fn(async () => ['static-v1', 'runtime-v2']),
      delete: vi.fn(async (key: string) => {
        deleted.push(key)
        return true
      }),
    }
    const update1 = vi.fn(async () => undefined)
    const update2 = vi.fn(async () => undefined)
    const unregister1 = vi.fn(async () => true)
    const serviceWorker = {
      getRegistrations: vi.fn(async () => [
        { update: update1, unregister: unregister1 },
        { update: update2, unregister: unregister1 },
      ]),
    }
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    const replace = vi.fn()

    await refreshWebCache({
      caches: cachesApi,
      serviceWorker,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      location: {
        href: 'https://relay.example.com/sessions/abc?keep=1#pane',
        origin: 'https://relay.example.com',
        replace,
      },
      now: () => 1732776123456,
    })

    expect(deleted).toEqual(['static-v1', 'runtime-v2'])
    expect(update1).toHaveBeenCalledTimes(1)
    expect(update2).toHaveBeenCalledTimes(1)
    expect(unregister1).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [fetchedUrl, fetchedInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(fetchedUrl.toString()).toBe('https://relay.example.com/')
    expect(fetchedInit.cache).toBe('reload')
    expect(fetchedInit.signal).toBeInstanceOf(AbortSignal)
    expect(replace).toHaveBeenCalledWith(
      'https://relay.example.com/sessions/abc?keep=1&_refresh=1732776123456#pane',
    )
  })

  it('tolerates missing or failing caches, serviceWorker, and fetch without blocking navigation', async () => {
    const replace = vi.fn()
    const failingCaches = {
      keys: vi.fn(async () => {
        throw new Error('caches disabled')
      }),
      delete: vi.fn(async () => false),
    }
    const failingSw = {
      getRegistrations: vi.fn(async () => [
        {
          update: vi.fn(async () => {
            throw new Error('offline')
          }),
        },
      ]),
    }
    const failingFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    await refreshWebCache({
      caches: failingCaches,
      serviceWorker: failingSw,
      fetch: failingFetch as unknown as typeof globalThis.fetch,
      location: {
        href: 'http://192.168.1.10:4567/',
        origin: 'http://192.168.1.10:4567',
        replace,
      },
      now: () => 42,
    })

    expect(replace).toHaveBeenCalledWith('http://192.168.1.10:4567/?_refresh=42')

    const replaceNullDeps = vi.fn()
    await refreshWebCache({
      caches: null,
      serviceWorker: null,
      fetch: null,
      location: {
        href: 'http://192.168.1.10:4567/pair#xyz',
        origin: 'http://192.168.1.10:4567',
        replace: replaceNullDeps,
      },
      now: () => 99,
    })

    expect(replaceNullDeps).toHaveBeenCalledWith('http://192.168.1.10:4567/pair?_refresh=99#xyz')
  })

  it('aborts a stalled root fetch after fetchTimeoutMs and still navigates', async () => {
    vi.useFakeTimers()
    try {
      const replace = vi.fn()
      let aborted = false
      const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      })

      const done = refreshWebCache({
        caches: null,
        serviceWorker: null,
        fetch: hangingFetch as unknown as typeof globalThis.fetch,
        location: {
          href: 'https://app.kettu.sh/',
          origin: 'https://app.kettu.sh',
          replace,
        },
        now: () => 777,
        fetchTimeoutMs: 50,
      })

      await vi.advanceTimersByTimeAsync(60)
      await done

      expect(aborted).toBe(true)
      expect(replace).toHaveBeenCalledWith('https://app.kettu.sh/?_refresh=777')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('reloadOnStaleChunks', () => {
  it('reloads once via the shared refresh helper on vite:preloadError and stops reload loops', () => {
    const target = new EventTarget()
    const storage = new MemoryStorage()
    const refresh = vi.fn()

    const stop = reloadOnStaleChunks({ target, storage, refresh })

    const first = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    expect(storage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe('1')
    expect(refresh).toHaveBeenCalledTimes(1)

    const second = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)

    stop()
  })

  it('catches stale dynamic import unhandled rejections without reacting to ordinary errors', () => {
    const target = new EventTarget()
    const storage = new MemoryStorage()
    const refresh = vi.fn()

    const stop = reloadOnStaleChunks({ target, storage, refresh })

    const ordinary = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: new Error('Regular application error'),
    })
    target.dispatchEvent(ordinary)
    expect(ordinary.defaultPrevented).toBe(false)
    expect(refresh).not.toHaveBeenCalled()

    const chunkFailure = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: new TypeError(
        'Failed to fetch dynamically imported module: https://app.kettu.sh/assets/x.js',
      ),
    })
    target.dispatchEvent(chunkFailure)
    expect(chunkFailure.defaultPrevented).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)

    const duplicate = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason: new TypeError('Importing a module script failed.'),
    })
    target.dispatchEvent(duplicate)
    expect(duplicate.defaultPrevented).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)

    stop()
  })

  it('does not reload when sessionStorage is unavailable or throws', () => {
    const target = new EventTarget()
    const refresh = vi.fn()
    const brokenStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }

    const stopNull = reloadOnStaleChunks({ target, storage: null, refresh })
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    stopNull()

    const stopBroken = reloadOnStaleChunks({ target, storage: brokenStorage, refresh })
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    stopBroken()

    expect(refresh).not.toHaveBeenCalled()
  })

  it('identifies known stale-chunk error messages', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module'))).toBe(
      true,
    )
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkError('error loading dynamically imported module')).toBe(true)
    expect(isStaleChunkError(new Error('Loading chunk 42 failed'))).toBe(true)
    expect(isStaleChunkError(new Error('Network timeout'))).toBe(false)
    expect(isStaleChunkError(null)).toBe(false)
  })
})

describe('web entrypoints share cache refresh and stale-chunk handling', () => {
  const webDir = fileURLToPath(new URL('.', import.meta.url))

  it('wires stripRefreshQueryParam and installStaleChunkReload across Direct, Hosted, and Relay', () => {
    for (const file of ['main.tsx', 'hosted/start.tsx', 'relay/start.tsx']) {
      const source = readFileSync(`${webDir}${file}`, 'utf8')
      expect(source, file).toContain('stripRefreshQueryParam()')
      expect(source, file).toContain('installStaleChunkReload()')
    }

    const launchSource = readFileSync(`${webDir}launch.ts`, 'utf8')
    expect(launchSource).toContain('refreshWebCache()')
    expect(launchSource).not.toContain('location.reload()')

    const cacheRefreshCode = readFileSync(`${webDir}cache-refresh.ts`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(cacheRefreshCode).not.toContain('indexedDB')
    expect(cacheRefreshCode).not.toContain('localStorage')
    expect(cacheRefreshCode).not.toContain('document.cookie')
    expect(cacheRefreshCode).not.toContain('unregister(')
  })
})
