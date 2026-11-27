// Short-lived LRU cache and in-flight deduplication for file hover preview reads.

import type { FileContent } from '@shared/files'
import { host } from '@renderer/lib/host'

export type FilePreviewSource =
  | { kind: 'project'; projectPath: string; path: string; asText?: boolean }
  | { kind: 'agent'; sessionId: string; path: string }

interface CacheEntry {
  value: FileContent
  fetchedAt: number
  weight: number
}

export const FILE_PREVIEW_CACHE_TTL_MS = 15_000
const MAX_CACHE_ENTRIES = 32
const MAX_CACHE_WEIGHT = 2_000_000
const NON_TEXT_WEIGHT = 1_024

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<FileContent>>()
let totalWeight = 0

export function previewSourceKey(source: FilePreviewSource): string {
  if (source.kind === 'agent') return `agent\0${source.sessionId}\0${source.path}`
  return `project\0${source.projectPath}\0${source.path}\0${source.asText ? 'text' : 'auto'}`
}

function weightOf(content: FileContent): number {
  return content.kind === 'text' ? Math.max(NON_TEXT_WEIGHT, content.text.length) : NON_TEXT_WEIGHT
}

function removeEntry(key: string): void {
  const existing = cache.get(key)
  if (!existing) return
  cache.delete(key)
  totalWeight -= existing.weight
}

function writeEntry(key: string, value: FileContent, now: number): void {
  removeEntry(key)
  const weight = weightOf(value)
  if (weight > MAX_CACHE_WEIGHT) return
  cache.set(key, { value, fetchedAt: now, weight })
  totalWeight += weight
  while ((cache.size > MAX_CACHE_ENTRIES || totalWeight > MAX_CACHE_WEIGHT) && cache.size > 1) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    removeEntry(oldest)
  }
}

/** Returns a fresh cached read synchronously, or null when missing or expired. */
export function getCachedFilePreview(
  source: FilePreviewSource,
  now = Date.now(),
): FileContent | null {
  const key = previewSourceKey(source)
  const entry = cache.get(key)
  if (!entry) return null
  if (now - entry.fetchedAt > FILE_PREVIEW_CACHE_TTL_MS) {
    removeEntry(key)
    return null
  }
  // Refresh LRU recency.
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function defaultFetcher(source: FilePreviewSource): Promise<FileContent> {
  if (source.kind === 'agent') {
    return host('files.readAgentFile', { sessionId: source.sessionId, path: source.path })
  }
  return host('files.read', {
    projectPath: source.projectPath,
    path: source.path,
    ...(source.asText && { asText: true }),
  })
}

/**
 * Reads a file for hover preview via the existing host RPCs, reusing fresh cached entries and
 * deduplicating concurrent reads for the same target. Failed reads are never cached.
 */
export function readFilePreview(
  source: FilePreviewSource,
  options?: {
    force?: boolean
    now?: () => number
    fetcher?: (source: FilePreviewSource) => Promise<FileContent>
  },
): Promise<FileContent> {
  const now = options?.now ?? Date.now
  const key = previewSourceKey(source)
  if (!options?.force) {
    const cached = getCachedFilePreview(source, now())
    if (cached) return Promise.resolve(cached)
  } else {
    removeEntry(key)
  }
  const running = inFlight.get(key)
  if (running) return running

  const fetch = options?.fetcher ?? defaultFetcher
  const request = fetch(source)
    .then((value) => {
      writeEntry(key, value, now())
      return value
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}

/** Clears cached preview reads and in-flight trackers; intended for tests. */
export function clearFilePreviewCache(): void {
  cache.clear()
  inFlight.clear()
  totalWeight = 0
}
