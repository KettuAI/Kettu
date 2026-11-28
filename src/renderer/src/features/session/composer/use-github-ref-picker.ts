import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitHubRepository,
  RepositoryReferenceItem,
  RepositoryReferenceSearchResult,
  RepositoryReferenceUnavailableReason,
} from '@shared/git'
import { hostAt } from '@renderer/lib/host'
import { filterAndRankReferences, type GitHubRefRow } from './github-picker'

// Debounce remote `gh` searches while typing so cached recent items filter instantaneously.
const SEARCH_DEBOUNCE_MS = 200
// Short client-side cache for the repository's recent issues/PRs so reopening `#` is instant.
const CLIENT_CACHE_MS = 60_000
const MAX_CLIENT_CACHE = 20

interface CachedList {
  at: number
  result: RepositoryReferenceSearchResult
}

const recentCache = new Map<string, CachedList>()

function cacheKey(hostId: string | null, repo: GitHubRepository): string {
  return `${hostId ?? ''}\0${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
}

function readFreshRecent(key: string): RepositoryReferenceSearchResult | null {
  const entry = recentCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at >= CLIENT_CACHE_MS) {
    recentCache.delete(key)
    return null
  }
  return entry.result
}

function writeRecent(key: string, result: RepositoryReferenceSearchResult): void {
  if (result.kind !== 'ok') return
  recentCache.delete(key)
  recentCache.set(key, { at: Date.now(), result })
  while (recentCache.size > MAX_CLIENT_CACHE) {
    const oldest = recentCache.keys().next().value
    if (oldest === undefined) break
    recentCache.delete(oldest)
  }
}

/** Clears the in-memory recent-references cache; used by unit tests. */
export function clearGitHubRefPickerCache(): void {
  recentCache.clear()
}

export interface GitHubRefPickerState {
  repo: GitHubRepository | null
  rows: GitHubRefRow[]
  /** True while the initial repository list is still loading and no items are available yet. */
  loading: boolean
  /** True while a remote search for the current non-empty query is in flight. */
  searching: boolean
  /** Set when `gh` is missing, signed out, timed out, or failed. */
  unavailable: RepositoryReferenceUnavailableReason | null
  /** True when the user has typed a non-empty filter query after `#`. */
  hasQuery: boolean
}

const IDLE: GitHubRefPickerState = {
  repo: null,
  rows: [],
  loading: false,
  searching: false,
  unavailable: null,
  hasQuery: false,
}

/**
 * Loads recent issues/PRs and runs debounced remote searches for the active `#` picker when the
 * project is linked to a GitHub repository. Drops stale responses when the query or repo changes.
 */
export function useGitHubRefPicker(
  hostId: string | null,
  repo: GitHubRepository | null,
  query: string | null,
): GitHubRefPickerState {
  const active = repo !== null && query !== null
  const repoOwner = repo?.owner ?? ''
  const repoName = repo?.repo ?? ''
  const key = active ? cacheKey(hostId, repo) : ''
  const cachedRecent = active ? readFreshRecent(key) : null

  const [recentState, setRecentState] = useState<{
    key: string
    result: RepositoryReferenceSearchResult | null
  }>({ key: '', result: null })
  const [searchState, setSearchState] = useState<{
    key: string
    query: string
    result: RepositoryReferenceSearchResult | null
  }>({ key: '', query: '', result: null })
  const requestSeq = useRef(0)

  // Fetch recent issues & PRs when `#` opens and no fresh client cache entry exists.
  useEffect(() => {
    if (!active || cachedRecent !== null) return
    let cancelled = false
    void hostAt(hostId, 'git.searchReferences', {
      owner: repoOwner,
      repo: repoName,
      query: '',
    })
      .then(
        (result): RepositoryReferenceSearchResult => result,
        (): RepositoryReferenceSearchResult => ({ kind: 'unavailable', reason: 'failed' }),
      )
      .then((result) => {
        if (cancelled) return
        writeRecent(key, result)
        setRecentState({ key, result })
      })
    return () => {
      cancelled = true
    }
  }, [active, cachedRecent, hostId, key, repoName, repoOwner])

  const trimmed = query?.trim() ?? ''
  const recentResult = cachedRecent ?? (recentState.key === key ? recentState.result : null)
  const ghBlocked =
    recentResult?.kind === 'unavailable' &&
    (recentResult.reason === 'gh-missing' || recentResult.reason === 'gh-signed-out')

  // Debounced remote search whenever the user types a non-empty number or title filter.
  useEffect(() => {
    if (!active || !trimmed || ghBlocked) return
    let cancelled = false
    const seq = ++requestSeq.current
    const timer = window.setTimeout(() => {
      void hostAt(hostId, 'git.searchReferences', {
        owner: repoOwner,
        repo: repoName,
        query: trimmed,
      })
        .then(
          (result): RepositoryReferenceSearchResult => result,
          (): RepositoryReferenceSearchResult => ({ kind: 'unavailable', reason: 'failed' }),
        )
        .then((result) => {
          if (cancelled || requestSeq.current !== seq) return
          setSearchState({ key, query: trimmed, result })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, ghBlocked, hostId, key, repoName, repoOwner, trimmed])

  return useMemo<GitHubRefPickerState>(() => {
    if (!active || !repo) return IDLE
    const remote =
      trimmed !== '' && searchState.key === key && searchState.query === trimmed
        ? searchState.result
        : null
    const items: RepositoryReferenceItem[] = []
    if (remote?.kind === 'ok') items.push(...remote.items)
    if (recentResult?.kind === 'ok') items.push(...recentResult.items)
    const rows = filterAndRankReferences(items, trimmed)
    const unavailable =
      recentResult?.kind === 'unavailable'
        ? recentResult.reason
        : remote?.kind === 'unavailable' && rows.length === 0
          ? remote.reason
          : null
    const loading = recentResult === null && rows.length === 0
    const searching = !ghBlocked && trimmed !== '' && remote === null
    return {
      repo,
      rows,
      loading,
      searching,
      unavailable,
      hasQuery: trimmed !== '',
    }
  }, [active, ghBlocked, key, recentResult, repo, searchState, trimmed])
}
