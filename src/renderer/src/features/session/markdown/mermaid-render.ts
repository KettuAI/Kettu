import { createMermaidPlugin, type MermaidConfig } from '@streamdown/mermaid'
import type { SettingsFile } from '@shared/settings'
import type { Theme } from '@shared/themes'

export interface MermaidPicture {
  url: string
  width: number
  xml: string
}

export type MermaidRenderResult = MermaidPicture | { error: string }

/** Prefix for Mermaid render IDs so globals.css isolates their temporary `d${id}` host div. */
export const MERMAID_RENDER_ID_PREFIX = 'kettu-mermaid-'

const SVG_NS = 'http://www.w3.org/2000/svg'
const RENDER_CONFIG_VERSION = 'v1|strict|base|htmlLabels:false|padding:8|rx6'
const IDLE_TIMEOUT_MS = 120

const DESKTOP_CACHE_LIMITS = {
  maxEntries: 96,
  maxBytes: 16 * 1024 * 1024,
} as const

const WEB_CACHE_LIMITS = {
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
} as const

const isWebClient = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { kettu?: { client?: string } }).kettu?.client === 'web'

function defaultCacheLimits(): MermaidCacheLimits {
  return isWebClient() ? WEB_CACHE_LIMITS : DESKTOP_CACHE_LIMITS
}

export interface MermaidCacheLimits {
  maxEntries: number
  maxBytes: number
}

/** Rough UTF-16 byte footprint of a cached Mermaid picture entry. */
export function estimatePictureBytes(picture: MermaidPicture): number {
  return (picture.url.length + picture.xml.length) * 2
}

/**
 * Stable signature covering the fixed Mermaid render config and resolved theme tokens.
 * Any change in light/dark mode, custom theme palette, or user font yields a distinct key.
 */
export function mermaidThemeKey(variables: Record<string, string>): string {
  const tokens = Object.keys(variables)
    .sort()
    .map((key) => `${key}=${variables[key] ?? ''}`)
  return `${RENDER_CONFIG_VERSION}|${tokens.join('|')}`
}

/** Cache key pairing a diagram's source with its resolved theme/config signature. */
export function mermaidCacheKey(code: string, themeKey: string): string {
  return `${themeKey}\0${code}`
}

/**
 * The diagram's colors from the theme's tokens, read as values: Mermaid derives shades from them,
 * which a `var()` would defeat.
 */
export function readMermaidThemeVariables(): Record<string, string> {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { fontFamily: 'sans-serif', fontSize: '12px' }
  }
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const surface = token('--bg-surface')
  const text = token('--text-primary')
  const line = token('--border-default')
  return {
    background: surface,
    mainBkg: surface,
    primaryColor: surface,
    secondaryColor: token('--bg-subtle'),
    tertiaryColor: token('--bg-subtle'),
    primaryBorderColor: line,
    secondaryBorderColor: line,
    tertiaryBorderColor: line,
    nodeBorder: line,
    clusterBkg: token('--bg-subtle'),
    clusterBorder: line,
    primaryTextColor: text,
    secondaryTextColor: text,
    tertiaryTextColor: text,
    textColor: text,
    titleColor: text,
    edgeLabelBackground: surface,
    lineColor: token('--border-strong'),
    fontFamily: (document.body && getComputedStyle(document.body).fontFamily) || 'sans-serif',
    fontSize: '12px',
  }
}

export interface MermaidThemeSnapshot {
  dark: boolean
  theme: Theme | null
  fonts: SettingsFile['appearance']['fonts']
  variables: Record<string, string>
  themeKey: string
}

let cachedThemeSnapshot: MermaidThemeSnapshot | null = null

/**
 * Memoizes resolved CSS tokens by `(dark, theme, fonts)` so remounting diagrams across session
 * switches avoids redundant `getComputedStyle` calls while keeping cache keys theme-isolated.
 */
export function getMermaidThemeSnapshot(
  dark: boolean,
  theme: Theme | null,
  fonts: SettingsFile['appearance']['fonts'],
): MermaidThemeSnapshot {
  if (
    cachedThemeSnapshot &&
    cachedThemeSnapshot.dark === dark &&
    cachedThemeSnapshot.theme === theme &&
    cachedThemeSnapshot.fonts === fonts
  ) {
    return cachedThemeSnapshot
  }
  const variables = readMermaidThemeVariables()
  cachedThemeSnapshot = {
    dark,
    theme,
    fonts,
    variables,
    themeKey: mermaidThemeKey(variables),
  }
  return cachedThemeSnapshot
}

/** Refreshes the memoized theme snapshot from live computed styles if they diverged. */
export function refreshMermaidThemeSnapshot(
  dark: boolean,
  theme: Theme | null,
  fonts: SettingsFile['appearance']['fonts'],
): MermaidThemeSnapshot {
  const variables = readMermaidThemeVariables()
  const themeKey = mermaidThemeKey(variables)
  cachedThemeSnapshot = { dark, theme, fonts, variables, themeKey }
  return cachedThemeSnapshot
}

/**
 * The diagram as a picture: an `<img>` runs none of the SVG's scripts and loads nothing it
 * references. Mermaid sizes its SVG to its container, so the picture takes the size its view box
 * gives it instead. `xml` is the same SVG on a page of the theme's background, for the viewer and
 * the saved file, which are not seen on the thread's.
 */
export function pictureOf(svg: string, background: string): MermaidRenderResult {
  // Labels with a line break are HTML inside the SVG, with a bare `<br>` that XML parsing rejects,
  // so it is read as HTML and written back as XML.
  const root = new DOMParser().parseFromString(svg, 'text/html').body.querySelector('svg')
  if (!root) return { error: 'The output holds no SVG.' }
  const [x = 0, y = 0, width, height] = (root.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map(Number)
  if (!width || !height) return { error: 'The SVG has no usable view box.' }
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style')
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
  const page = root.ownerDocument.createElementNS(SVG_NS, 'rect')
  page.setAttribute('x', String(x))
  page.setAttribute('y', String(y))
  page.setAttribute('width', String(width))
  page.setAttribute('height', String(height))
  page.setAttribute('fill', background)
  // The diagram's own styles may name `rect`.
  page.setAttribute('style', `fill: ${background}`)
  root.prepend(page)
  return { url, width, xml: new XMLSerializer().serializeToString(root) }
}

interface CacheEntry {
  picture: MermaidPicture
  bytes: number
}

/** Bounded LRU cache for rendered Mermaid SVG pictures, capped by both entry count and bytes. */
export class MermaidPictureCache {
  private readonly entries = new Map<string, CacheEntry>()
  private totalBytes = 0

  constructor(private readonly getLimits: () => MermaidCacheLimits = defaultCacheLimits) {}

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.totalBytes
  }

  get(key: string): MermaidPicture | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.picture
  }

  set(key: string, picture: MermaidPicture): boolean {
    const { maxEntries, maxBytes } = this.getLimits()
    const bytes = estimatePictureBytes(picture)
    if (maxEntries <= 0 || maxBytes <= 0 || bytes > maxBytes) {
      return false
    }
    this.delete(key)
    this.entries.set(key, { picture, bytes })
    this.totalBytes += bytes
    while (
      (this.entries.size > maxEntries || this.totalBytes > maxBytes) &&
      this.entries.size > 0
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    return true
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.entries.delete(key)
    this.totalBytes -= entry.bytes
    return true
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }
}

export interface MermaidRenderRequest {
  code: string
  themeKey: string
  variables: Record<string, string>
}

export interface MermaidRenderHandle {
  promise: Promise<MermaidRenderResult>
  cancel: () => void
}

export interface MermaidRendererDeps {
  renderSvg: (
    id: string,
    code: string,
    variables: Record<string, string>,
    themeKey: string,
  ) => Promise<{ svg: string }>
  toPicture?: (svg: string, background: string) => MermaidRenderResult
  schedule?: (run: () => void) => () => void
  limits?: () => MermaidCacheLimits
  cleanupTempNodes?: (renderId: string) => void
}

interface PendingJob {
  key: string
  code: string
  themeKey: string
  variables: Record<string, string>
  subscribers: number
  started: boolean
  cancelled: boolean
  promise: Promise<MermaidRenderResult>
  resolve: (result: MermaidRenderResult) => void
}

const CANCELLED_RESULT: MermaidRenderResult = { error: 'Cancelled' }

/**
 * Yields at least one animation frame so session switches paint first, then runs during an idle
 * window (with a short deadline fallback so diagrams still appear promptly while streaming).
 */
function scheduleNonBlocking(run: () => void): () => void {
  let cancelled = false
  let cancelIdle: (() => void) | null = null

  const runWhenIdle = (): void => {
    if (cancelled) return
    if (typeof requestIdleCallback === 'function') {
      const idleId = requestIdleCallback(
        () => {
          cancelIdle = null
          if (!cancelled) run()
        },
        { timeout: IDLE_TIMEOUT_MS },
      )
      cancelIdle = () => cancelIdleCallback(idleId)
      return
    }
    const timer = setTimeout(() => {
      cancelIdle = null
      if (!cancelled) run()
    }, 0)
    cancelIdle = () => clearTimeout(timer)
  }

  if (typeof requestAnimationFrame === 'function') {
    const rafId = requestAnimationFrame(runWhenIdle)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      cancelIdle?.()
      cancelIdle = null
    }
  }

  const timer = setTimeout(runWhenIdle, 0)
  return () => {
    cancelled = true
    clearTimeout(timer)
    cancelIdle?.()
    cancelIdle = null
  }
}

function defaultCleanupTempNodes(renderId: string): void {
  if (typeof document === 'undefined') return
  document.getElementById(`d${renderId}`)?.remove()
  document.getElementById(renderId)?.remove()
}

export function buildMermaidConfig(variables: Record<string, string>): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: variables,
    // Nodes take the cards' 6 px corners and a 30 px height.
    themeCSS: '.node rect { rx: 6px; ry: 6px; }',
    flowchart: { htmlLabels: false, padding: 8 },
  }
}

/**
 * Creates an isolated Mermaid render coordinator with bounded LRU caching, in-flight deduplication,
 * and a non-blocking serial execution queue to avoid global Mermaid config races and main-thread
 * stalls when switching sessions.
 */
export function createMermaidRenderer(deps: MermaidRendererDeps) {
  const cache = new MermaidPictureCache(deps.limits ?? defaultCacheLimits)
  const toPicture = deps.toPicture ?? pictureOf
  const schedule = deps.schedule ?? scheduleNonBlocking
  const cleanupTempNodes = deps.cleanupTempNodes ?? defaultCleanupTempNodes

  const inFlight = new Map<string, PendingJob>()
  const queue: PendingJob[] = []
  let running = false
  let cancelScheduledDrain: (() => void) | null = null
  let nextRenderId = 0

  function scheduleDrain(): void {
    if (running || cancelScheduledDrain || queue.length === 0) return
    cancelScheduledDrain = schedule(() => {
      cancelScheduledDrain = null
      void drainNext()
    })
  }

  async function drainNext(): Promise<void> {
    if (running) return
    const job = queue.shift()
    if (!job) return
    if (job.cancelled) {
      scheduleDrain()
      return
    }

    running = true
    job.started = true
    const renderId = `${MERMAID_RENDER_ID_PREFIX}${++nextRenderId}`
    let result: MermaidRenderResult
    try {
      const { svg } = await deps.renderSvg(renderId, job.code, job.variables, job.themeKey)
      result = toPicture(svg, job.variables.background ?? '')
      if (!('error' in result)) {
        cache.set(job.key, result)
      }
    } catch (error: unknown) {
      result = { error: error instanceof Error ? error.message : String(error) }
    } finally {
      cleanupTempNodes(renderId)
      if (inFlight.get(job.key) === job) {
        inFlight.delete(job.key)
      }
      running = false
    }

    job.resolve(result)
    if (queue.length > 0) {
      scheduleDrain()
    }
  }

  function getCached(code: string, themeKey: string): MermaidPicture | undefined {
    return cache.get(mermaidCacheKey(code, themeKey))
  }

  function request({ code, themeKey, variables }: MermaidRenderRequest): MermaidRenderHandle {
    const key = mermaidCacheKey(code, themeKey)
    const cached = cache.get(key)
    if (cached) {
      return {
        promise: Promise.resolve(cached),
        cancel: () => {},
      }
    }

    let job = inFlight.get(key)
    if (!job) {
      let resolveJob!: (result: MermaidRenderResult) => void
      const promise = new Promise<MermaidRenderResult>((resolve) => {
        resolveJob = resolve
      })
      job = {
        key,
        code,
        themeKey,
        variables,
        subscribers: 0,
        started: false,
        cancelled: false,
        promise,
        resolve: resolveJob,
      }
      inFlight.set(key, job)
      queue.push(job)
      scheduleDrain()
    }

    job.subscribers += 1
    let active = true
    const targetJob = job

    return {
      promise: targetJob.promise,
      cancel: () => {
        if (!active) return
        active = false
        targetJob.subscribers -= 1
        if (targetJob.subscribers > 0 || targetJob.started || targetJob.cancelled) return
        targetJob.cancelled = true
        if (inFlight.get(key) === targetJob) {
          inFlight.delete(key)
        }
        const index = queue.indexOf(targetJob)
        if (index >= 0) queue.splice(index, 1)
        if (queue.length === 0 && cancelScheduledDrain) {
          cancelScheduledDrain()
          cancelScheduledDrain = null
        }
        targetJob.resolve(CANCELLED_RESULT)
      },
    }
  }

  function clear(): void {
    cache.clear()
    for (const job of queue.splice(0, queue.length)) {
      job.cancelled = true
      if (inFlight.get(job.key) === job) {
        inFlight.delete(job.key)
      }
      job.resolve(CANCELLED_RESULT)
    }
    if (cancelScheduledDrain) {
      cancelScheduledDrain()
      cancelScheduledDrain = null
    }
  }

  return {
    getCached,
    request,
    clear,
    cache,
    inFlightCount: () => inFlight.size,
    queueLength: () => queue.length,
  }
}

const plugin = createMermaidPlugin()
let activePluginThemeKey: string | null = null

const defaultRenderer = createMermaidRenderer({
  renderSvg: async (id, code, variables, themeKey) => {
    const mermaid =
      activePluginThemeKey === themeKey
        ? plugin.getMermaid()
        : plugin.getMermaid(buildMermaidConfig(variables))
    activePluginThemeKey = themeKey
    return await mermaid.render(id, code)
  },
})

/** Synchronously reads a cached rendered picture, refreshing its LRU position on hit. */
export function getCachedMermaidPicture(
  code: string,
  themeKey: string,
): MermaidPicture | undefined {
  return defaultRenderer.getCached(code, themeKey)
}

/** Queues or deduplicates a Mermaid render request, returning a cancellable handle. */
export function requestMermaidPicture(request: MermaidRenderRequest): MermaidRenderHandle {
  return defaultRenderer.request(request)
}

/** Test-only helper to inspect, prime, or reset the module-level Mermaid cache. */
export const _mermaidRenderForTests = {
  size: () => defaultRenderer.cache.size,
  bytes: () => defaultRenderer.cache.bytes,
  inFlightCount: () => defaultRenderer.inFlightCount(),
  queueLength: () => defaultRenderer.queueLength(),
  seed: (code: string, themeKey: string, picture: MermaidPicture) =>
    defaultRenderer.cache.set(mermaidCacheKey(code, themeKey), picture),
  clear: () => {
    defaultRenderer.clear()
    activePluginThemeKey = null
    cachedThemeSnapshot = null
  },
}
