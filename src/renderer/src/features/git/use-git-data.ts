import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, CommitDetails, FileDiff } from '@shared/git'
import { errorMessage, host } from '@renderer/lib/host'
import { diffId, diffKey, useFilesStore } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'

export interface Loaded<T> {
  data: T | null
  error: string | null
}

export interface FileDiffState extends Loaded<FileDiff> {
  retry: () => void
}

// One git.changes request per project per git status update, shared across cards and side panes.
const changesCache = new Map<string, { updatedAt: number; load: Promise<ChangedFile[]> }>()

// One git.fileDiff request per working-tree file per status revision, bounded so large repos stay light.
const MAX_CACHED_DIFFS = 64
interface CachedFileDiff {
  revision: string
  load: Promise<FileDiff>
  value?: FileDiff
}
const fileDiffCache = new Map<string, CachedFileDiff>()

function fileDiffCacheKey(
  projectPath: string,
  file: Pick<ChangedFile, 'path' | 'oldPath'>,
): string {
  return `${projectPath}\0${file.path}\0${file.oldPath ?? ''}`
}

function fileDiffRevision(
  updatedAt: number,
  file: Pick<ChangedFile, 'status' | 'insertions' | 'deletions'>,
): string {
  return `${updatedAt}\0${file.status}\0${file.insertions ?? ''}\0${file.deletions ?? ''}`
}

function rememberFileDiff(key: string, entry: CachedFileDiff): void {
  if (fileDiffCache.has(key)) fileDiffCache.delete(key)
  fileDiffCache.set(key, entry)
  while (fileDiffCache.size > MAX_CACHED_DIFFS) {
    const oldest = fileDiffCache.keys().next().value
    if (oldest === undefined || oldest === key) break
    fileDiffCache.delete(oldest)
  }
}

/** Loads one working-tree file diff, reusing the cached request while the file revision matches. */
export function loadFileDiff(
  projectPath: string,
  file: Pick<ChangedFile, 'path' | 'oldPath' | 'status' | 'insertions' | 'deletions'>,
  updatedAt: number,
  force = false,
): Promise<FileDiff> {
  const key = fileDiffCacheKey(projectPath, file)
  const revision = fileDiffRevision(updatedAt, file)
  const cached = fileDiffCache.get(key)
  if (!force && cached && cached.revision === revision) {
    rememberFileDiff(key, cached)
    return cached.load
  }
  const load = host('git.fileDiff', {
    projectPath,
    path: file.path,
    oldPath: file.oldPath,
    ref: null,
  })
  const entry: CachedFileDiff = { revision, load }
  rememberFileDiff(key, entry)
  load.then(
    (value) => {
      if (fileDiffCache.get(key) === entry) entry.value = value
    },
    () => {
      if (fileDiffCache.get(key) === entry) fileDiffCache.delete(key)
    },
  )
  return load
}

/** Returns the already-resolved cached working-tree diff for a file, if any. */
export function peekFileDiff(
  projectPath: string,
  file: Pick<ChangedFile, 'path' | 'oldPath'>,
): FileDiff | null {
  return fileDiffCache.get(fileDiffCacheKey(projectPath, file))?.value ?? null
}

/** Clears cached working-tree file diffs; intended for tests. */
export function clearFileDiffCache(): void {
  fileDiffCache.clear()
}

/**
 * Loads one changed file's working-tree diff only while `enabled`, reusing cached results across
 * collapse/expand cycles and refreshing whenever the repository status or file summary updates.
 */
export function useFileDiff(
  projectPath: string,
  file: Pick<ChangedFile, 'path' | 'oldPath' | 'status' | 'insertions' | 'deletions'>,
  enabled: boolean,
): FileDiffState {
  const updatedAt = useGitStore((s) => s.status[projectPath]?.updatedAt ?? 0)
  const storeKey = diffKey(projectPath, diffId({ path: file.path, ref: null }))
  const storeDiff = useFilesStore((s) => s.diffs[storeKey]?.result ?? null)
  const key = fileDiffCacheKey(projectPath, file)
  const revision = fileDiffRevision(updatedAt, file)
  const [attempt, setAttempt] = useState(0)
  const forceNext = useRef(false)
  const [state, setState] = useState<Loaded<FileDiff> & { key: string }>(() => ({
    data: fileDiffCache.get(key)?.value ?? storeDiff,
    error: null,
    key,
  }))

  useEffect(() => {
    if (!enabled) return
    let live = true
    const force = forceNext.current
    forceNext.current = false
    loadFileDiff(projectPath, file, updatedAt, force).then(
      (data) => live && setState({ data, error: null, key }),
      (error: unknown) =>
        live &&
        setState((s) => ({
          data: s.key === key ? s.data : (fileDiffCache.get(key)?.value ?? storeDiff),
          error: errorMessage(error),
          key,
        })),
    )
    return () => {
      live = false
    }
    // `file` fields are captured in `key` and `revision`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, revision, attempt])

  const retry = useCallback(() => {
    forceNext.current = true
    setState((s) => ({ ...s, error: null }))
    setAttempt((n) => n + 1)
  }, [])

  const cachedValue = fileDiffCache.get(key)?.value ?? null
  if (state.key !== key) {
    return { data: cachedValue ?? storeDiff, error: null, retry }
  }
  return {
    data: state.data ?? cachedValue ?? storeDiff,
    error: state.error,
    retry,
  }
}

function loadChanges(projectPath: string, updatedAt: number): Promise<ChangedFile[]> {
  const cached = changesCache.get(projectPath)
  if (cached && cached.updatedAt === updatedAt) return cached.load
  const load = host('git.changes', { projectPath })
  load.catch(() => {
    if (changesCache.get(projectPath)?.load === load) changesCache.delete(projectPath)
  })
  changesCache.set(projectPath, { updatedAt, load })
  return load
}

/**
 * Loads while `enabled`, and again whenever the project's status changes, keeping what it had
 * until the new answer arrives.
 */
function useLive<T>(
  projectPath: string,
  enabled: boolean,
  load: (updatedAt: number) => Promise<T>,
  key: string,
) {
  const updatedAt = useGitStore((s) => s.status[projectPath]?.updatedAt ?? 0)
  const [state, setState] = useState<Loaded<T> & { key: string }>({ data: null, error: null, key })
  useEffect(() => {
    if (!enabled) return
    let live = true
    load(updatedAt).then(
      (data) => live && setState({ data, error: null, key }),
      (error: unknown) => live && setState((s) => ({ ...s, error: errorMessage(error), key })),
    )
    return () => {
      live = false
    }
    // `load` is rebuilt every render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, updatedAt])
  return state.key === key ? state : { data: null, error: null }
}

export function useChanges(projectPath: string, enabled: boolean): Loaded<ChangedFile[]> {
  return useLive(
    projectPath,
    enabled,
    (updatedAt) => loadChanges(projectPath, updatedAt),
    projectPath,
  )
}

const NO_DELETED: ReadonlySet<string> = new Set()

/** Repository-relative paths currently marked deleted in git, shared across every card of a project. */
export function useDeletedGitPaths(projectPath: string): ReadonlySet<string> {
  const hasTrackedChanges = useGitStore((s) => {
    const status = s.status[projectPath]
    return !!status?.repo && status.changes.staged + status.changes.unstaged > 0
  })
  const { data } = useChanges(projectPath, hasTrackedChanges)
  return useMemo(() => {
    if (!hasTrackedChanges || !data) return NO_DELETED
    const deleted = data.filter((file) => file.status === 'deleted').map((file) => file.path)
    return deleted.length > 0 ? new Set(deleted) : NO_DELETED
  }, [hasTrackedChanges, data])
}

// A commit never changes, so its details are kept for the session.
const details = new Map<string, Promise<CommitDetails>>()

// Immutable commit file diffs, bounded so inspecting large histories stays light.
interface CachedCommitFileDiff {
  load: Promise<FileDiff>
  value?: FileDiff
}
const commitFileDiffCache = new Map<string, CachedCommitFileDiff>()

function commitFileDiffKey(
  projectPath: string,
  oid: string,
  file: Pick<ChangedFile, 'path' | 'oldPath'>,
): string {
  return `${projectPath}\0${oid}\0${file.path}\0${file.oldPath ?? ''}`
}

function rememberCommitFileDiff(key: string, entry: CachedCommitFileDiff): void {
  if (commitFileDiffCache.has(key)) commitFileDiffCache.delete(key)
  commitFileDiffCache.set(key, entry)
  while (commitFileDiffCache.size > MAX_CACHED_DIFFS) {
    const oldest = commitFileDiffCache.keys().next().value
    if (oldest === undefined || oldest === key) break
    commitFileDiffCache.delete(oldest)
  }
}

/** Loads one file's diff in an immutable commit against its first parent, cached per session. */
export function loadCommitFileDiff(
  projectPath: string,
  oid: string,
  file: Pick<ChangedFile, 'path' | 'oldPath'>,
  force = false,
): Promise<FileDiff> {
  const key = commitFileDiffKey(projectPath, oid, file)
  const cached = commitFileDiffCache.get(key)
  if (!force && cached) {
    rememberCommitFileDiff(key, cached)
    return cached.load
  }
  const load = host('git.fileDiff', {
    projectPath,
    path: file.path,
    oldPath: file.oldPath,
    ref: oid,
  })
  const entry: CachedCommitFileDiff = { load }
  rememberCommitFileDiff(key, entry)
  load.then(
    (value) => {
      if (commitFileDiffCache.get(key) === entry) entry.value = value
    },
    () => {
      if (commitFileDiffCache.get(key) === entry) commitFileDiffCache.delete(key)
    },
  )
  return load
}

/** Clears cached commit details and commit file diffs; intended for tests. */
export function clearCommitCaches(): void {
  details.clear()
  commitFileDiffCache.clear()
}

/** Loads one file's read-only diff for a specific commit while `enabled`. */
export function useCommitFileDiff(
  projectPath: string,
  oid: string,
  file: Pick<ChangedFile, 'path' | 'oldPath'>,
  enabled: boolean,
): FileDiffState {
  const key = commitFileDiffKey(projectPath, oid, file)
  const [attempt, setAttempt] = useState(0)
  const forceNext = useRef(false)
  const [state, setState] = useState<Loaded<FileDiff> & { key: string }>(() => ({
    data: commitFileDiffCache.get(key)?.value ?? null,
    error: null,
    key,
  }))

  useEffect(() => {
    if (!enabled) return
    let live = true
    const force = forceNext.current
    forceNext.current = false
    loadCommitFileDiff(projectPath, oid, file, force).then(
      (data) => live && setState({ data, error: null, key }),
      (error: unknown) =>
        live &&
        setState((s) => ({
          data: s.key === key ? s.data : (commitFileDiffCache.get(key)?.value ?? null),
          error: errorMessage(error),
          key,
        })),
    )
    return () => {
      live = false
    }
    // `file` fields are captured in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, attempt])

  const retry = useCallback(() => {
    forceNext.current = true
    setState((s) => ({ ...s, error: null }))
    setAttempt((n) => n + 1)
  }, [])

  const cachedValue = commitFileDiffCache.get(key)?.value ?? null
  if (state.key !== key) {
    return { data: cachedValue, error: null, retry }
  }
  return {
    data: state.data ?? cachedValue,
    error: state.error,
    retry,
  }
}

export function loadCommit(projectPath: string, oid: string): Promise<CommitDetails> {
  const key = `${projectPath}\0${oid}`
  let load = details.get(key)
  if (!load) {
    load = host('git.commit', { projectPath, oid })
    load.catch(() => details.delete(key))
    details.set(key, load)
  }
  return load
}

export function useCommit(
  projectPath: string,
  oid: string,
  enabled: boolean,
): Loaded<CommitDetails> {
  const [state, setState] = useState<Loaded<CommitDetails> & { oid: string }>({
    data: null,
    error: null,
    oid,
  })
  useEffect(() => {
    if (!enabled) return
    let live = true
    loadCommit(projectPath, oid).then(
      (data) => live && setState({ data, error: null, oid }),
      (error: unknown) => live && setState({ data: null, error: errorMessage(error), oid }),
    )
    return () => {
      live = false
    }
  }, [enabled, projectPath, oid])
  return state.oid === oid ? state : { data: null, error: null }
}
