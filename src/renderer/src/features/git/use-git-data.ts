import { useEffect, useState } from 'react'
import type { ChangedFile, CommitDetails, LogCommit } from '@shared/git'
import { errorMessage, host } from '@renderer/lib/host'
import { useGitStore } from '@renderer/stores/git'

export interface Loaded<T> {
  data: T | null
  error: string | null
}

/**
 * Loads while `enabled`, and again whenever the project's status changes, keeping what it had
 * until the new answer arrives.
 */
function useLive<T>(projectPath: string, enabled: boolean, load: () => Promise<T>, key: string) {
  const updatedAt = useGitStore((s) => s.status[projectPath]?.updatedAt ?? 0)
  const [state, setState] = useState<Loaded<T> & { key: string }>({ data: null, error: null, key })
  useEffect(() => {
    if (!enabled) return
    let live = true
    load().then(
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
  return useLive(projectPath, enabled, () => host('git.changes', { projectPath }), projectPath)
}

export function useIncoming(
  projectPath: string,
  from: 'upstream' | 'base',
  enabled: boolean,
): Loaded<LogCommit[]> {
  return useLive(
    projectPath,
    enabled,
    () => host('git.incoming', { projectPath, from }),
    `${projectPath}\0${from}`,
  )
}

// A commit never changes, so its details are kept for the session.
const details = new Map<string, Promise<CommitDetails>>()

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
