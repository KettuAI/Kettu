import { create } from 'zustand'
import type { FileContent } from '@shared/files'
import { errorMessage, host } from '@renderer/lib/host'
import { useGitStore } from './git'
import { toggleSidePane } from './view'

export interface ProjectFiles {
  paths: string[]
  /** The same paths, for telling whether a reference in a reply names a file. */
  known: ReadonlySet<string>
  truncated: boolean
  error: string | null
}

export interface OpenFile {
  path: string
  /** The line to show and mark, from a reference such as `src/x.ts:12`. */
  line: number | null
  content: FileContent | null
  error: string | null
}

interface FilesStore {
  byProject: Record<string, ProjectFiles>
  /** The file shown in each project's Files pane. */
  open: Record<string, OpenFile>
}

export const useFilesStore = create<FilesStore>()(() => ({ byProject: {}, open: {} }))

const inFlight = new Map<string, Promise<void>>()

/** Lists the project's files; one request at a time per project. */
export function loadFiles(projectPath: string): Promise<void> {
  const running = inFlight.get(projectPath)
  if (running) return running
  const request = host('files.list', { projectPath })
    .then(({ paths, truncated }) => ({ paths, known: new Set(paths), truncated, error: null }))
    .catch((error: unknown) => {
      // A failed refresh keeps the list it had.
      const before = useFilesStore.getState().byProject[projectPath]
      return {
        paths: before?.paths ?? [],
        known: before?.known ?? new Set<string>(),
        truncated: before?.truncated ?? false,
        error: errorMessage(error),
      }
    })
    .then((files) => {
      useFilesStore.setState((s) => ({ byProject: { ...s.byProject, [projectPath]: files } }))
    })
    .finally(() => inFlight.delete(projectPath))
  inFlight.set(projectPath, request)
  return request
}

/** Lists the project's files unless they are already known. */
export function ensureFiles(projectPath: string): void {
  if (!useFilesStore.getState().byProject[projectPath]) void loadFiles(projectPath)
}

/** Shows a file in the project's Files pane, opening the pane, scrolled to `line` if given. */
export function openFile(projectPath: string, path: string, line: number | null = null): void {
  toggleSidePane(projectPath, 'files', true)
  const current = useFilesStore.getState().open[projectPath]
  const same = current?.path === path
  setOpen(projectPath, {
    path,
    line,
    content: same ? current.content : null,
    error: null,
  })
  void readOpenFile(projectPath)
}

export function closeFile(projectPath: string): void {
  useFilesStore.setState((s) => {
    const open = { ...s.open }
    delete open[projectPath]
    return { open }
  })
}

function setOpen(projectPath: string, file: OpenFile): void {
  useFilesStore.setState((s) => ({ open: { ...s.open, [projectPath]: file } }))
}

/** Reads the open file again, keeping what is shown until the new text arrives. */
async function readOpenFile(projectPath: string): Promise<void> {
  const file = useFilesStore.getState().open[projectPath]
  if (!file) return
  const { path } = file
  try {
    const content = await host('files.read', { projectPath, path })
    const now = useFilesStore.getState().open[projectPath]
    if (now?.path === path) setOpen(projectPath, { ...now, content, error: null })
  } catch (error) {
    const now = useFilesStore.getState().open[projectPath]
    if (now?.path === path) setOpen(projectPath, { ...now, error: errorMessage(error) })
  }
}

/** Lists the files and reads the open one again, after a change on disk or on window focus. */
export function refreshFiles(projectPath: string): void {
  if (!useFilesStore.getState().byProject[projectPath]) return
  void loadFiles(projectPath)
  void readOpenFile(projectPath)
}

// A new git status means the working tree changed, after an agent's edit as after one of yours;
// a burst of them refreshes once.
const REFRESH_DELAY_MS = 300
const timers = new Map<string, ReturnType<typeof setTimeout>>()
useGitStore.subscribe((state, previous) => {
  for (const [projectPath, status] of Object.entries(state.status)) {
    if (status === previous.status[projectPath]) continue
    clearTimeout(timers.get(projectPath))
    timers.set(
      projectPath,
      setTimeout(() => refreshFiles(projectPath), REFRESH_DELAY_MS),
    )
  }
})
