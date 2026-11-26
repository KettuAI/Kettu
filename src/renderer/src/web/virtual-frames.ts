// Virtual artifact frame host for hosted and relay web clients: fetches immutable version metadata
// and file bytes over the encrypted HostLink with an LRU cache, assembles HTML for isolated
// opaque-origin static shells, and serves on-demand read-only VFS requests over MessagePort.

import { artifactFileType } from '@shared/artifact-files'
import { parseServed } from '@shared/artifact-page'
import { SANDBOX_FRAME_PATHS, type SandboxFrameMode } from '@shared/artifact-policy'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import type { ArtifactContent } from '@shared/artifacts'
import type { ArtifactOpenResult } from '@shared/ipc'
import type { Locale } from '@shared/locale'
import type { HostLink } from '@shared/remote/link'
import { errorCode } from '@renderer/lib/host'
import { assembleHtml, assembleViewerHtml, MAX_INLINE_ASSET_BYTES, toDataUrl } from './sandbox-html'

const FRAME_PATH = '/frame/'
/** Maximum in-memory artifact bytes kept in the browser LRU cache. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_CACHE_ENTRIES = 512
/** Maximum cached immutable version manifests (including inline index HTML). */
const MAX_VERSION_READS = 64

interface OpenFrameEntry {
  artifactId: string
  framePath: string
}

interface CachedBytes {
  type: string
  bytes: Uint8Array
}

export interface PreparedSandboxFrame {
  sandboxPath: string
  search: string
  html: string
  vfsPort: MessagePort
  strict: boolean
  dispose: () => void
}

export interface VirtualFrameHost {
  /** Assembles sandboxed HTML and a read-only VFS port for the requested frame URL. */
  prepare(src: string): Promise<PreparedSandboxFrame>
  /** Subscribes to strict-mode upgrades for older hosts that do not report `strict`. */
  onStrictUpgrade(frameUrl: string, listener: () => void): () => void
  /** Guards restricted capabilities (`files`, `sample`) on lax frames and triggers a strict reload when needed. */
  allowCapability(frameUrl: string, cap: string): boolean
}

function tokenFromUrl(url: string): { token: string; rest: string; search: string } | null {
  const parsed = URL.parse(url, location.href)
  if (!parsed || parsed.origin !== location.origin || !parsed.pathname.startsWith(FRAME_PATH)) {
    return null
  }
  const slash = parsed.pathname.indexOf('/', FRAME_PATH.length)
  if (slash < 0) return null
  return {
    token: parsed.pathname.slice(FRAME_PATH.length, slash),
    rest: parsed.pathname.slice(slash),
    search: parsed.search,
  }
}

function bytesOf(value: unknown): Uint8Array | null {
  const raw = (value as { bytes?: unknown } | null)?.bytes
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  return null
}

function currentLocale(): Locale {
  return document.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en'
}

/** Creates a virtual artifact frame manager backed by the encrypted `HostLink`. */
export function createVirtualFrames(link: HostLink): {
  open: (id: string) => Promise<ArtifactOpenResult>
  close: (url: string) => Promise<void>
  host: VirtualFrameHost
} {
  const openFrames = new Map<string, OpenFrameEntry>()
  /** Immutable version metadata cache (includes strict flag and file manifest). */
  const reads = new Map<string, Promise<ArtifactContent>>()
  /** Content-addressed file byte cache so canvas frames share CSS, JS and images without re-fetching. */
  const fileCache = new Map<string, CachedBytes>()
  const inflightFiles = new Map<string, Promise<CachedBytes | null>>()
  let cachedBytes = 0

  /** Artifacts promoted to strict isolation by the fallback guard for older hosts. */
  const forcedStrict = new Set<string>()
  /** Active sandbox mode and whether the host explicitly reported `strict`, keyed by frame root URL. */
  const frameSecurity = new Map<
    string,
    { artifactId: string; mode: SandboxFrameMode; strictKnown: boolean }
  >()
  const strictListeners = new Map<string, Set<() => void>>()

  function touchCache(key: string, entry: CachedBytes): void {
    const previous = fileCache.get(key)
    if (previous) {
      cachedBytes -= previous.bytes.byteLength
      fileCache.delete(key)
    }
    fileCache.set(key, entry)
    cachedBytes += entry.bytes.byteLength
    while (cachedBytes > MAX_CACHE_BYTES || fileCache.size > MAX_CACHE_ENTRIES) {
      const oldest = fileCache.keys().next().value
      if (oldest === undefined || oldest === key) break
      const removed = fileCache.get(oldest)!
      cachedBytes -= removed.bytes.byteLength
      fileCache.delete(oldest)
    }
  }

  function rememberVersion(key: string, promise: Promise<ArtifactContent>): void {
    reads.delete(key)
    reads.set(key, promise)
    while (reads.size > MAX_VERSION_READS) {
      const oldest = reads.keys().next().value
      if (oldest === undefined || oldest === key) break
      reads.delete(oldest)
    }
  }

  function readVersion(artifactId: string, version: number | null): Promise<ArtifactContent> {
    if (version !== null) {
      const key = `${artifactId}@${version}`
      const existing = reads.get(key)
      if (existing) {
        reads.delete(key)
        reads.set(key, existing)
        return existing
      }
      const promise = (
        link.request('artifacts.read', { id: artifactId, version }) as Promise<ArtifactContent>
      ).catch((error: unknown) => {
        reads.delete(key)
        throw error
      })
      rememberVersion(key, promise)
      return promise
    }
    return (link.request('artifacts.read', { id: artifactId }) as Promise<ArtifactContent>).then(
      (result) => {
        rememberVersion(`${artifactId}@${result.version}`, Promise.resolve(result))
        return result
      },
    )
  }

  function readFileBytes(
    artifactId: string,
    meta: ArtifactContent,
    filePath: string,
  ): Promise<CachedBytes | null> {
    const info = meta.files.find((f) => f.path === filePath)
    if (!info) return Promise.resolve(null)
    const cacheKey = info.hash
      ? `hash:${info.hash}`
      : `file:${artifactId}@${meta.version}:${filePath}`
    const cached = fileCache.get(cacheKey)
    if (cached) {
      // Refresh LRU position.
      fileCache.delete(cacheKey)
      fileCache.set(cacheKey, cached)
      return Promise.resolve(cached)
    }
    const pending = inflightFiles.get(cacheKey)
    if (pending) return pending
    const promise = (
      link.request('artifacts.file', {
        id: artifactId,
        version: meta.version,
        path: filePath,
      }) as Promise<{ type?: unknown; bytes?: unknown }>
    )
      .then((res) => {
        const bytes = bytesOf(res)
        if (!bytes) return null
        const entry: CachedBytes = {
          type: typeof res.type === 'string' ? res.type : artifactFileType(filePath),
          bytes,
        }
        touchCache(cacheKey, entry)
        return entry
      })
      .catch(() => null)
      .finally(() => {
        inflightFiles.delete(cacheKey)
      })
    inflightFiles.set(cacheKey, promise)
    return promise
  }

  async function open(id: string): Promise<ArtifactOpenResult> {
    let path: unknown
    try {
      path = ((await link.request('artifacts.openFrame', { id })) as { path?: unknown } | null)
        ?.path
    } catch (error) {
      if (errorCode(error) === 'not_found') return { failed: 'not_found' }
      throw error
    }
    if (typeof path !== 'string' || !path.startsWith(FRAME_PATH) || !path.endsWith('/')) {
      throw new Error('The host named no frame for the artifact')
    }
    const token = path.slice(FRAME_PATH.length, -1)
    openFrames.set(token, { artifactId: id, framePath: path })
    return { url: `${location.origin}${path}` }
  }

  async function close(url: string): Promise<void> {
    const parsed = URL.parse(url)
    if (!parsed || parsed.origin !== location.origin || !parsed.pathname.startsWith(FRAME_PATH)) {
      return
    }
    const token = parsed.pathname.slice(FRAME_PATH.length, -1)
    openFrames.delete(token)
    frameSecurity.delete(url)
    strictListeners.delete(url)
    await link.request('artifacts.closeFrame', { path: parsed.pathname })
  }

  async function prepare(src: string): Promise<PreparedSandboxFrame> {
    const parsed = tokenFromUrl(src)
    if (!parsed) throw new Error('Invalid artifact frame address')
    const entry = openFrames.get(parsed.token)
    if (!entry) throw new Error('The artifact frame is not open')
    const params = new URLSearchParams(parsed.search)
    const wanted = parseServed(parsed.rest, params)
    if (!wanted) throw new Error('Invalid artifact file path')

    const meta = await readVersion(entry.artifactId, wanted.version)
    const files = new Set(meta.files.map((f) => f.path))
    const frameUrl = `${location.origin}${entry.framePath}`

    const decoder = new TextDecoder()
    const readText = async (filePath: string): Promise<string | null> => {
      const found = await readFileBytes(entry.artifactId, meta, filePath)
      return found ? decoder.decode(found.bytes) : null
    }
    const readDataUrl = async (filePath: string): Promise<string | null> => {
      const info = meta.files.find((f) => f.path === filePath)
      if (!info || info.size > MAX_INLINE_ASSET_BYTES) return null
      const found = await readFileBytes(entry.artifactId, meta, filePath)
      return found ? toDataUrl(found.bytes, found.type) : null
    }

    let mode: SandboxFrameMode
    let html: string
    if (meta.type) {
      mode = 'viewer'
      const entryPath = CONTENT_ENTRIES[meta.type.name]
      const entryText = await readText(entryPath)
      const built = assembleViewerHtml({
        type: meta.type,
        version: meta.version,
        locale: currentLocale(),
        files,
        entryPath,
        entryText,
      })
      if (!built) throw new Error(`Unsupported artifact viewer: ${meta.type.name}`)
      html = built
    } else {
      const strict = meta.strict === true || forcedStrict.has(entry.artifactId)
      mode = strict ? 'strict' : 'default'
      const rawHtml =
        wanted.path === 'index.html' && meta.html !== '' ? meta.html : await readText(wanted.path)
      if (rawHtml === null) throw new Error(`Missing artifact page: ${wanted.path}`)
      html = await assembleHtml({
        html: rawHtml,
        path: wanted.path,
        page: wanted.page,
        files,
        readText,
        readDataUrl,
      })
    }

    frameSecurity.set(frameUrl, {
      artifactId: entry.artifactId,
      mode,
      strictKnown: meta.strict !== undefined,
    })

    // Read-only VFS channel serving dynamic fetch, XHR, lazy images, and large media inside the frame.
    const { port1, port2 } = new MessageChannel()
    let alive = true
    port1.onmessage = (event: MessageEvent) => {
      const req = event.data as { id?: unknown; path?: unknown } | null
      if (!alive || !req || typeof req.id !== 'number' || typeof req.path !== 'string') return
      const reqId = req.id
      const reqPath = req.path
      if (!files.has(reqPath)) {
        port1.postMessage({ id: reqId, ok: false })
        return
      }
      void readFileBytes(entry.artifactId, meta, reqPath).then((found) => {
        if (!alive) return
        if (!found) {
          port1.postMessage({ id: reqId, ok: false })
          return
        }
        // Transfer an independent buffer copy so the cached Uint8Array remains intact.
        const copy = found.bytes.slice().buffer
        port1.postMessage({ id: reqId, ok: true, type: found.type, bytes: copy }, [copy])
      })
    }
    port1.start()

    return {
      sandboxPath: SANDBOX_FRAME_PATHS[mode],
      search: parsed.search,
      html,
      vfsPort: port2,
      strict: mode === 'strict',
      dispose: () => {
        alive = false
        port1.onmessage = null
        port1.close()
      },
    }
  }

  function onStrictUpgrade(frameUrl: string, listener: () => void): () => void {
    let set = strictListeners.get(frameUrl)
    if (!set) {
      set = new Set()
      strictListeners.set(frameUrl, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) strictListeners.delete(frameUrl)
    }
  }

  function allowCapability(frameUrl: string, cap: string): boolean {
    if (cap !== 'files' && cap !== 'sample') return true
    const sec = frameSecurity.get(frameUrl)
    if (!sec) return false
    if (sec.mode === 'strict') return true
    // Never grant files/sample to a lax frame; if an older host omitted `strict`, promote and reload in strict mode.
    if (!sec.strictKnown) {
      forcedStrict.add(sec.artifactId)
      const listeners = strictListeners.get(frameUrl)
      if (listeners) {
        for (const notify of [...listeners]) notify()
      }
    }
    return false
  }

  return {
    open,
    close,
    host: { prepare, onStrictUpgrade, allowCapability },
  }
}
