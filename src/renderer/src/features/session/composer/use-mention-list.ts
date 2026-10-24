import { useDeferredValue, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ThreadState } from '@shared/thread'
import { loadFiles, useFilesStore, type ProjectFiles } from '@renderer/stores/files'
import { useThreadsStore } from '@renderer/stores/threads'
import { foldersOf, matchMentions, usedFiles, type MentionRow } from './mentions'

export interface MentionList {
  rows: MentionRow[]
  /** Nothing is typed, so the rows are the files the session used. */
  used: boolean
  files: ProjectFiles | undefined
  /** No project is chosen yet, as on New session, so there are no files to mention. */
  noProject: boolean
}

const NO_PATHS: string[] = []
const NO_ROWS: MentionRow[] = []

const usedCache = new WeakMap<
  ThreadState,
  { projectPath: string; known: ReadonlySet<string>; used: string[] }
>()

/** The used files, worked out again only when this session's thread changes. */
function usedIn(
  thread: ThreadState | null | undefined,
  projectPath: string,
  known: ReadonlySet<string>,
): string[] {
  if (!thread) return NO_PATHS
  const hit = usedCache.get(thread)
  if (hit && hit.projectPath === projectPath && hit.known === known) return hit.used
  const used = usedFiles(thread, projectPath, known)
  usedCache.set(thread, { projectPath, known, used })
  return used
}

/**
 * The rows for a mention's query, or none while no mention is typed. The project's files are
 * listed again as each mention starts, so files made since show up.
 */
export function useMentionList(
  sessionId: string,
  projectPath: string | null,
  query: string | null,
): MentionList {
  const active = query !== null && projectPath !== null
  useEffect(() => {
    if (active) void loadFiles(projectPath)
  }, [active, projectPath])
  const files = useFilesStore((s) => (active ? s.byProject[projectPath] : undefined))
  // Matching tens of thousands of paths can trail the typing rather than hold it up; the rows
  // shown are always those of the query they were matched for.
  const typed = useDeferredValue(query)
  const used = useThreadsStore(
    useShallow((s) =>
      typed === '' && files && projectPath
        ? usedIn(s.replicas[sessionId]?.state, projectPath, files.known)
        : NO_PATHS,
    ),
  )
  const matched = useMemo(
    () => (files && typed ? matchMentions(typed, files.paths, foldersOf(files.paths)) : NO_ROWS),
    [files, typed],
  )
  const usedRows = useMemo(
    () => used.map((path) => ({ path, folder: false, positions: [] })),
    [used],
  )
  // The same object while nothing changed, so the composer can tell when the list did.
  const noProject = projectPath === null
  return useMemo(() => {
    if (typed === null || noProject) return { rows: NO_ROWS, used: false, files, noProject }
    return typed === ''
      ? { rows: usedRows, used: true, files, noProject }
      : { rows: matched, used: false, files, noProject }
  }, [typed, usedRows, matched, files, noProject])
}
