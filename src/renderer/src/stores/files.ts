import { create } from 'zustand'
import type { EditorState, Text } from '@codemirror/state'
import type { FileContent } from '@shared/files'
import type { FileDiff } from '@shared/git'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
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
  /** The editor holds edits that are not saved. */
  dirty: boolean
  /** The file on disk is not the one the edits started from, and the user has not chosen yet. */
  changedOnDisk: boolean
  /** The version on disk while edits are unsaved, when it differs from theirs. */
  diskVersion: string | null
  /** The version on disk the user chose to overwrite with their edits. */
  kept: string | null
  saving: boolean
  saveError: string | null
  /** Counts dropped edits, so the editor starts over from the file. */
  resets: number
}

/** A file's change from the branch popover, shown in the preview's place. */
export interface DiffTarget {
  /** Relative to the repository root, as git names it. */
  path: string
  oldPath: string | null
  /** The commit, or null for the working tree against HEAD. */
  ref: string | null
  /** The same file as the Files pane names it, or null when it lies outside the project. */
  projectFile: string | null
}

export interface DiffView extends DiffTarget {
  result: FileDiff | null
  error: string | null
}

/** What waits on the answer to "Save changes?". */
export type PendingChange = { kind: 'open'; path: string; line: number | null } | { kind: 'close' }

interface FilesStore {
  byProject: Record<string, ProjectFiles>
  /** The file shown in each project's Files pane. */
  open: Record<string, OpenFile>
  /** Markdown files show their source instead of the rendered preview, for every file. */
  markdownSource: boolean
  /** By project, the change to the open file that asks first because it has unsaved edits. */
  pending: Record<string, PendingChange>
  /** By project, the diff that covers the open file until it is closed. */
  diffs: Record<string, DiffView>
}

export const useFilesStore = create<FilesStore>()(() => ({
  byProject: {},
  open: {},
  markdownSource: false,
  pending: {},
  diffs: {},
}))

/**
 * Each project's editor state, which the editor keeps current, so edits and their undo history
 * outlive the editor while the pane is hidden. `base` is the text on disk at `version`.
 */
export interface Buffer {
  path: string
  version: string
  base: Text
  state: EditorState
}

export const buffers = new Map<string, Buffer>()

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

function fresh(path: string, line: number | null, content: FileContent | null): OpenFile {
  return {
    path,
    line,
    content,
    error: null,
    dirty: false,
    changedOnDisk: false,
    diskVersion: null,
    kept: null,
    saving: false,
    saveError: null,
    resets: 0,
  }
}

/**
 * Shows a file in the project's Files pane, opening the pane, scrolled to `line` if given. With
 * unsaved edits in another file, it asks first.
 */
export function openFile(projectPath: string, path: string, line: number | null = null): void {
  toggleSidePane(projectPath, 'files', true)
  closeDiff(projectPath)
  const current = useFilesStore.getState().open[projectPath]
  if (current?.dirty && current.path !== path) {
    setPending(projectPath, { kind: 'open', path, line })
    return
  }
  showFile(projectPath, path, line)
}

function showFile(projectPath: string, path: string, line: number | null): void {
  const current = useFilesStore.getState().open[projectPath]
  if (current?.path === path) setOpen(projectPath, { ...current, line })
  else {
    buffers.delete(projectPath)
    setOpen(projectPath, fresh(path, line, null))
  }
  void readOpenFile(projectPath)
}

/** Closes the project's open file, asking first when it has unsaved edits. */
export function closeFile(projectPath: string): void {
  if (useFilesStore.getState().open[projectPath]?.dirty) {
    setPending(projectPath, { kind: 'close' })
    return
  }
  closeNow(projectPath)
}

function closeNow(projectPath: string): void {
  buffers.delete(projectPath)
  useFilesStore.setState((s) => {
    const open = { ...s.open }
    delete open[projectPath]
    return { open }
  })
}

function setPending(projectPath: string, change: PendingChange | null): void {
  useFilesStore.setState((s) => {
    const pending = { ...s.pending }
    if (change) pending[projectPath] = change
    else delete pending[projectPath]
    return { pending }
  })
}

/** The answer to "Save changes?": the waiting change happens unless it is cancelled or the save fails. */
export async function answerPending(
  projectPath: string,
  answer: 'cancel' | 'discard' | 'save',
): Promise<void> {
  const change = useFilesStore.getState().pending[projectPath]
  setPending(projectPath, null)
  if (!change || answer === 'cancel') return
  if (answer === 'save' && !(await saveFile(projectPath))) return
  if (change.kind === 'close') closeNow(projectPath)
  else {
    buffers.delete(projectPath)
    const current = useFilesStore.getState().open[projectPath]
    if (current) setOpen(projectPath, { ...current, dirty: false })
    showFile(projectPath, change.path, change.line)
  }
}

function setOpen(projectPath: string, file: OpenFile): void {
  useFilesStore.setState((s) => ({ open: { ...s.open, [projectPath]: file } }))
}

/** Changes the open file if it is still `path`. */
function update(
  projectPath: string,
  path: string,
  change: Partial<OpenFile> | ((file: OpenFile) => Partial<OpenFile>),
): void {
  const now = useFilesStore.getState().open[projectPath]
  if (now?.path !== path) return
  setOpen(projectPath, { ...now, ...(typeof change === 'function' ? change(now) : change) })
}

/** The editor's word on whether its text differs from the file it started from. */
export function setDirty(projectPath: string, path: string, dirty: boolean): void {
  update(projectPath, path, (file) => (file.dirty === dirty ? {} : { dirty, saveError: null }))
}

/**
 * Reads the open file again, keeping what is shown until the new text arrives. Unsaved edits are
 * never replaced: a different file on disk only says so.
 */
async function readOpenFile(projectPath: string): Promise<void> {
  const file = useFilesStore.getState().open[projectPath]
  if (!file) return
  const { path } = file
  try {
    const content = await host('files.read', { projectPath, path })
    update(projectPath, path, (now) => {
      const buffer = buffers.get(projectPath)
      if (!now.dirty || buffer?.path !== path) return { content, error: null }
      const version = content.kind === 'text' ? content.version : null
      if (version === buffer.version || (version !== null && version === now.kept)) return {}
      return { changedOnDisk: true, diskVersion: version, error: null }
    })
  } catch (error) {
    update(projectPath, path, { error: errorMessage(error) })
  }
}

/** Saves the open file's edits; false when they are still unsaved. */
export async function saveFile(projectPath: string): Promise<boolean> {
  const file = useFilesStore.getState().open[projectPath]
  const buffer = buffers.get(projectPath)
  if (!file?.dirty || buffer?.path !== file.path) return true
  if (file.saving) return false
  const { path } = file
  const doc = buffer.state.doc
  const text = buffer.state.sliceDoc()
  update(projectPath, path, { saving: true, saveError: null })
  try {
    const written = await host('files.write', {
      projectPath,
      path,
      text,
      version: file.kept ?? buffer.version,
    })
    buffer.version = written.version
    buffer.base = doc
    update(projectPath, path, {
      saving: false,
      // Typing during the save left more to save.
      dirty: !buffer.state.doc.eq(doc),
      changedOnDisk: false,
      diskVersion: null,
      kept: null,
      content: {
        kind: 'text',
        path,
        size: written.size,
        text,
        version: written.version,
        editable: true,
      },
    })
    return true
  } catch (error) {
    if (errorCode(error) === 'conflict') {
      update(projectPath, path, { saving: false })
      await readOpenFile(projectPath)
      // The file may have changed back meanwhile; the bar shows only when it still differs.
      update(projectPath, path, (now) =>
        now.changedOnDisk ? {} : { saveError: errorMessage(error) },
      )
    } else {
      update(projectPath, path, { saving: false, saveError: errorMessage(error) })
    }
    return false
  }
}

/** Drops the open file's edits and shows the file as it is on disk. */
export function discardEdits(projectPath: string): void {
  const file = useFilesStore.getState().open[projectPath]
  if (!file) return
  buffers.delete(projectPath)
  setOpen(projectPath, { ...fresh(file.path, null, file.content), resets: file.resets + 1 })
  void readOpenFile(projectPath)
}

/** Keeps the edits over the change on disk: the next save overwrites that version. */
export function keepEdits(projectPath: string): void {
  const file = useFilesStore.getState().open[projectPath]
  if (!file) return
  update(projectPath, file.path, { changedOnDisk: false, kept: file.diskVersion })
}

/** The files with unsaved edits, for asking before the app quits. */
export function unsavedFiles(): { projectPath: string; path: string }[] {
  return Object.entries(useFilesStore.getState().open)
    .filter(([, file]) => file.dirty)
    .map(([projectPath, file]) => ({ projectPath, path: file.path }))
}

/** Saves every file with unsaved edits; false when any is still unsaved. */
export async function saveAll(): Promise<boolean> {
  const results = await Promise.all(unsavedFiles().map((f) => saveFile(f.projectPath)))
  return results.every(Boolean)
}

/** Lists the files and reads the open one again, after a change on disk or on window focus. */
export function refreshFiles(projectPath: string): void {
  const diff = useFilesStore.getState().diffs[projectPath]
  // The working tree's side of a diff changes with the files.
  if (diff?.ref === null) void readDiff(projectPath, diff)
  if (!useFilesStore.getState().byProject[projectPath]) return
  void loadFiles(projectPath)
  void readOpenFile(projectPath)
}

const sameTarget = (a: DiffTarget | undefined, b: DiffTarget): boolean =>
  a?.path === b.path && a.oldPath === b.oldPath && a.ref === b.ref

async function readDiff(projectPath: string, target: DiffTarget): Promise<void> {
  const settle = (change: Partial<DiffView>): void =>
    useFilesStore.setState((s) =>
      sameTarget(s.diffs[projectPath], target)
        ? { diffs: { ...s.diffs, [projectPath]: { ...s.diffs[projectPath]!, ...change } } }
        : {},
    )
  try {
    const { path, oldPath, ref } = target
    settle({ result: await host('git.fileDiff', { projectPath, path, oldPath, ref }), error: null })
  } catch (error) {
    settle({ error: errorMessage(error) })
  }
}

/**
 * Shows a file's change in the project's Files pane, over the open file, which keeps its edits
 * and comes back when the diff closes.
 */
export function openDiff(projectPath: string, target: DiffTarget): void {
  toggleSidePane(projectPath, 'files', true)
  const current = useFilesStore.getState().diffs[projectPath]
  if (!sameTarget(current, target)) {
    useFilesStore.setState((s) => ({
      diffs: { ...s.diffs, [projectPath]: { ...target, result: null, error: null } },
    }))
  }
  void readDiff(projectPath, target)
}

export function closeDiff(projectPath: string): void {
  if (!useFilesStore.getState().diffs[projectPath]) return
  useFilesStore.setState((s) => {
    const diffs = { ...s.diffs }
    delete diffs[projectPath]
    return { diffs }
  })
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

// Main asks before quitting with unsaved files, so it hears of every change to them.
let reported = ''
useFilesStore.subscribe(() => {
  const files = unsavedFiles()
  const key = JSON.stringify(files)
  if (key === reported) return
  reported = key
  window.overbench.app?.setUnsaved(files)
})
