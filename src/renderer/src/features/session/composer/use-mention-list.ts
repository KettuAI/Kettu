import { useDeferredValue, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { loadFiles, useFilesStore, type ProjectFiles } from '@renderer/stores/files'
import { useThreadsStore } from '@renderer/stores/threads'
import { foldersOf, matchMentions, usedFiles, type MentionRow } from './mentions'

export interface MentionList {
  rows: MentionRow[]
  /** Nothing is typed, so the rows are the files the session used. */
  used: boolean
  files: ProjectFiles | undefined
}

const NO_PATHS: string[] = []
const NO_ROWS: MentionRow[] = []

/**
 * The rows for a mention's query, or none while no mention is typed. The project's files are
 * listed again as each mention starts, so files made since show up.
 */
export function useMentionList(
  sessionId: string,
  projectPath: string,
  query: string | null,
): MentionList {
  const active = query !== null
  useEffect(() => {
    if (active) void loadFiles(projectPath)
  }, [active, projectPath])
  const files = useFilesStore((s) => (active ? s.byProject[projectPath] : undefined))
  // Matching tens of thousands of paths can trail the typing rather than hold it up; the rows
  // shown are always those of the query they were matched for.
  const typed = useDeferredValue(query)
  const used = useThreadsStore(
    useShallow((s) =>
      typed === '' && files
        ? usedFiles(s.replicas[sessionId]?.state, projectPath, files.known)
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
  if (typed === null) return { rows: NO_ROWS, used: false, files }
  return typed === ''
    ? { rows: usedRows, used: true, files }
    : { rows: matched, used: false, files }
}
