import { create } from 'zustand'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { FileContent } from '@shared/files'
import type { FileDiff } from '@shared/git'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { useGitStore } from './git'
import { showSidePane } from './view'

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
  /** Counts requests to show `line`, so the editor jumps once per request, not on every visit. */
  jump: number
  /** Shown in the preview tab, which the next single click replaces; an edit makes it a tab. */
  preview: boolean
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

/** A project's open files in tab order, and the path of the one the pane shows. */
export interface OpenTabs {
  files: OpenFile[]
  active: string
}

/** The file the pane shows, or null when the project has none open. */
export function activeFile(tabs: OpenTabs | null | undefined): OpenFile | null {
  return tabs?.files.find((file) => file.path === tabs.active) ?? null
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

/** The tab that asks "Save changes?" before it closes. */
export interface PendingClose {
  path: string
}

interface FilesStore {
  byProject: Record<string, ProjectFiles>
  /** The files open in each project's Files pane. */
  open: Record<string, OpenTabs>
  /** Markdown files show their source instead of the rendered preview, for every file. */
  markdownSource: boolean
  /** SVG files show their source instead of the picture, for every file. */
  svgSource: boolean
  /** By project, the tab that asks first because it has unsaved edits. */
  pending: Record<string, PendingClose>
  /** By project, the diff that covers the open file until it is closed. */
  diffs: Record<string, DiffView>
}

export const useFilesStore = create<FilesStore>()(() => ({
  byProject: {},
  open: {},
  markdownSource: false,
  svgSource: false,
  pending: {},
  diffs: {},
}))

/**
 * Each open file's editor state, which the editor keeps current, so edits and their undo history
 * outlive the editor while the pane is hidden or another tab shows. `base` is the text on disk at
 * `version`.
 */
export interface Buffer {
  path: string
  version: string
  base: Text
  state: EditorState
  /** Where the editor was scrolled to when it last left the file. */
  scroll: ReturnType<EditorView['scrollSnapshot']> | null
  /** The last jump request the editor acted on. */
  jumped: number
}

const buffers = new Map<string, Buffer>()

const bufferKey = (projectPath: string, path: string): string => `${projectPath}\0${path}`

export const getBuffer = (projectPath: string, path: string): Buffer | undefined =>
  buffers.get(bufferKey(projectPath, path))

export function putBuffer(projectPath: string, buffer: Buffer): void {
  buffers.set(bufferKey(projectPath, buffer.path), buffer)
}

function dropBuffer(projectPath: string, path: string): void {
  buffers.delete(bufferKey(projectPath, path))
}

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
    jump: line === null ? 0 : 1,
    preview: false,
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

const tabsOf = (projectPath: string): OpenTabs | undefined =>
  useFilesStore.getState().open[projectPath]

const findFile = (projectPath: string, path: string): OpenFile | undefined =>
  tabsOf(projectPath)?.files.find((file) => file.path === path)

function setTabs(projectPath: string, tabs: OpenTabs | null): void {
  useFilesStore.setState((s) => {
    const open = { ...s.open }
    if (tabs) open[projectPath] = tabs
    else delete open[projectPath]
    return { open }
  })
}

/**
 * Shows a file in the project's Files pane, opening the pane in the side panel in view and the
 * file's tab, scrolled to `line` if given. A `preview` open takes the preview tab's place, which a
 * regular one never does.
 */
export function openFile(
  projectPath: string,
  path: string,
  line: number | null = null,
  options: { preview?: boolean } = {},
): void {
  showSidePane(projectPath, 'files')
  closeDiff(projectPath)
  const tabs = tabsOf(projectPath)
  if (tabs?.files.some((file) => file.path === path)) {
    setTabs(projectPath, {
      active: path,
      files: tabs.files.map((file) =>
        file.path === path
          ? {
              ...file,
              line,
              jump: line === null ? file.jump : file.jump + 1,
              preview: file.preview && !!options.preview,
            }
          : file,
      ),
    })
    void readOpenFile(projectPath, path)
    return
  }
  const added: OpenFile = { ...fresh(path, line, null), preview: !!options.preview }
  const files = tabs ? [...tabs.files] : []
  const replaced = options.preview ? files.findIndex((file) => file.preview) : -1
  if (replaced >= 0) {
    dropBuffer(projectPath, files[replaced]!.path)
    files[replaced] = added
  } else {
    files.splice(tabs ? files.findIndex((file) => file.path === tabs.active) + 1 : 0, 0, added)
  }
  setTabs(projectPath, { files, active: path })
  void readOpenFile(projectPath, path)
}

/** Shows another of the project's open files; one not read since it was left is read again. */
export function activateTab(projectPath: string, path: string): void {
  const tabs = tabsOf(projectPath)
  if (!tabs || tabs.active === path || !tabs.files.some((file) => file.path === path)) return
  setTabs(projectPath, { ...tabs, active: path })
  void readOpenFile(projectPath, path)
}

/** Makes the preview tab a regular one, which the next single click leaves alone. */
export function keepTab(projectPath: string, path: string): void {
  update(projectPath, path, (file) => (file.preview ? { preview: false } : {}))
}

/** Moves the tab at `from` to `to`. */
export function moveTab(projectPath: string, from: number, to: number): void {
  const tabs = tabsOf(projectPath)
  if (!tabs || from === to || !tabs.files[from] || to < 0 || to >= tabs.files.length) return
  const files = [...tabs.files]
  files.splice(to, 0, files.splice(from, 1)[0]!)
  setTabs(projectPath, { ...tabs, files })
}

/** Closes a tab, asking first when it has unsaved edits. */
export function closeFile(projectPath: string, path: string): void {
  if (findFile(projectPath, path)?.dirty) {
    setPending(projectPath, { path })
    return
  }
  closeNow(projectPath, path)
}

/** Closes the project's shown tab, if it has one. */
export function closeActiveFile(projectPath: string): boolean {
  const tabs = tabsOf(projectPath)
  if (!tabs) return false
  closeFile(projectPath, tabs.active)
  return true
}

function closeNow(projectPath: string, path: string): void {
  const tabs = tabsOf(projectPath)
  const index = tabs?.files.findIndex((file) => file.path === path) ?? -1
  if (!tabs || index < 0) return
  dropBuffer(projectPath, path)
  const files = tabs.files.filter((file) => file.path !== path)
  if (files.length === 0) {
    setTabs(projectPath, null)
    return
  }
  // The tab that takes the closed one's place, else the one before it.
  const active = tabs.active === path ? files[Math.min(index, files.length - 1)]!.path : tabs.active
  setTabs(projectPath, { files, active })
  if (active !== tabs.active) void readOpenFile(projectPath, active)
}

function setPending(projectPath: string, change: PendingClose | null): void {
  useFilesStore.setState((s) => {
    const pending = { ...s.pending }
    if (change) pending[projectPath] = change
    else delete pending[projectPath]
    return { pending }
  })
}

/** The answer to "Save changes?": the tab closes unless it is cancelled or the save fails. */
export async function answerPending(
  projectPath: string,
  answer: 'cancel' | 'discard' | 'save',
): Promise<void> {
  const change = useFilesStore.getState().pending[projectPath]
  setPending(projectPath, null)
  if (!change || answer === 'cancel') return
  if (answer === 'save' && !(await saveFile(projectPath, change.path))) return
  closeNow(projectPath, change.path)
}

/** Changes the open file `path` if it is still open. */
function update(
  projectPath: string,
  path: string,
  change: Partial<OpenFile> | ((file: OpenFile) => Partial<OpenFile>),
): void {
  const tabs = tabsOf(projectPath)
  const index = tabs?.files.findIndex((file) => file.path === path) ?? -1
  if (!tabs || index < 0) return
  const files = [...tabs.files]
  const now = files[index]!
  files[index] = { ...now, ...(typeof change === 'function' ? change(now) : change) }
  setTabs(projectPath, { ...tabs, files })
}

/** The editor's word on whether its text differs from the file it started from. */
export function setDirty(projectPath: string, path: string, dirty: boolean): void {
  update(projectPath, path, (file) =>
    file.dirty === dirty ? {} : { dirty, saveError: null, ...(dirty && { preview: false }) },
  )
}

/** Shows a Markdown file rendered instead of its source, from the top. */
export function showMarkdownRendered(projectPath: string, path: string): void {
  useFilesStore.setState({ markdownSource: false })
  update(projectPath, path, { line: null })
}

/** A media URL without its token: the file's name and the time it was granted at. */
export const mediaVersion = (url: string): string => url.replace(/^[^:]*:\/\/[^/]*/, '')

/** A read of the media file shown, unchanged since: only its grant's token differs. */
function sameMedia(shown: FileContent | null, read: FileContent): boolean {
  return (
    shown?.kind === 'media' &&
    read.kind === 'media' &&
    shown.grant.mimeType === read.grant.mimeType &&
    shown.grant.size === read.grant.size &&
    mediaVersion(shown.grant.url) === mediaVersion(read.grant.url)
  )
}

export const isSvgFile = (path: string) => /\.svg$/i.test(path)

const readsSource = (path: string) => isSvgFile(path) && useFilesStore.getState().svgSource

/**
 * Reads an open file again, keeping what is shown until the new text arrives. Unsaved edits are
 * never replaced: a different file on disk only says so. An unchanged media file keeps its URL,
 * so a clip goes on playing, unless `renew` asks for the fresh grant.
 */
async function readOpenFile(projectPath: string, path: string, renew = false): Promise<void> {
  if (!findFile(projectPath, path)) return
  const asText = readsSource(path)
  try {
    const content = await host('files.read', { projectPath, path, ...(asText && { asText }) })
    update(projectPath, path, (now) => {
      // The choice of an SVG's picture or source changed meanwhile, and its own read follows.
      if (readsSource(path) !== asText) return {}
      const buffer = getBuffer(projectPath, path)
      if (!renew && sameMedia(now.content, content)) return { error: null }
      // An SVG's picture has no text to set the edits against; they wait for its source.
      if (!now.dirty || !buffer || content.kind === 'media') {
        return { content, error: null }
      }
      // Back from the picture, the source shows, and the bar says if it changed.
      const shown = now.content?.kind === 'media' ? { content } : {}
      const version = content.kind === 'text' ? content.version : null
      if (version === buffer.version || (version !== null && version === now.kept)) return shown
      return { ...shown, changedOnDisk: true, diskVersion: version, error: null }
    })
  } catch (error) {
    update(projectPath, path, { error: errorMessage(error) })
  }
}

/** Shows every SVG as its source, or as its picture, until changed; open ones are read again. */
export function showSvgSource(source: boolean): void {
  useFilesStore.setState({ svgSource: source })
  for (const [projectPath, tabs] of Object.entries(useFilesStore.getState().open)) {
    for (const file of tabs.files)
      if (isSvgFile(file.path)) void readOpenFile(projectPath, file.path)
  }
}

/** Reads an open media file again for a fresh grant, since main may have dropped its own. */
export function renewOpenFile(projectPath: string, path: string): void {
  void readOpenFile(projectPath, path, true)
}

/** Saves an open file's edits; false when they are still unsaved. */
export async function saveFile(projectPath: string, path: string): Promise<boolean> {
  const file = findFile(projectPath, path)
  const buffer = getBuffer(projectPath, path)
  if (!file?.dirty || !buffer) return true
  if (file.saving) return false
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
    // Saved while an SVG's picture shows: the picture is read again, at its new version.
    const picture = findFile(projectPath, path)?.content?.kind === 'media'
    update(projectPath, path, {
      saving: false,
      // Typing during the save left more to save.
      dirty: !buffer.state.doc.eq(doc),
      changedOnDisk: false,
      diskVersion: null,
      kept: null,
      ...(!picture && {
        content: {
          kind: 'text',
          path,
          size: written.size,
          text,
          version: written.version,
          editable: true,
        },
      }),
    })
    if (picture) void readOpenFile(projectPath, path)
    return true
  } catch (error) {
    if (errorCode(error) === 'conflict') {
      update(projectPath, path, { saving: false })
      await readOpenFile(projectPath, path)
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

/** Drops an open file's edits and shows the file as it is on disk. */
export function discardEdits(projectPath: string, path: string): void {
  const file = findFile(projectPath, path)
  if (!file) return
  dropBuffer(projectPath, path)
  update(projectPath, path, {
    ...fresh(path, null, file.content),
    jump: file.jump,
    resets: file.resets + 1,
  })
  void readOpenFile(projectPath, path)
}

/** Keeps the edits over the change on disk: the next save overwrites that version. */
export function keepEdits(projectPath: string, path: string): void {
  const file = findFile(projectPath, path)
  if (file) update(projectPath, path, { changedOnDisk: false, kept: file.diskVersion })
}

/** The files with unsaved edits, for asking before the app quits. */
export function unsavedFiles(): { projectPath: string; path: string }[] {
  return Object.entries(useFilesStore.getState().open).flatMap(([projectPath, tabs]) =>
    tabs.files.filter((file) => file.dirty).map((file) => ({ projectPath, path: file.path })),
  )
}

/** Saves every file with unsaved edits; false when any is still unsaved. */
export async function saveAll(): Promise<boolean> {
  const results = await Promise.all(unsavedFiles().map((f) => saveFile(f.projectPath, f.path)))
  return results.every(Boolean)
}

/** Lists the files and reads the shown one again, after a change on disk or on window focus. */
export function refreshFiles(projectPath: string): void {
  const diff = useFilesStore.getState().diffs[projectPath]
  // The working tree's side of a diff changes with the files.
  if (diff?.ref === null) void readDiff(projectPath, diff)
  if (!useFilesStore.getState().byProject[projectPath]) return
  void loadFiles(projectPath)
  const tabs = tabsOf(projectPath)
  if (tabs) void readOpenFile(projectPath, tabs.active)
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
 * Shows a file's change in the project's Files pane, over the open files, which keep their edits
 * and come back when the diff closes.
 */
export function openDiff(projectPath: string, target: DiffTarget): void {
  showSidePane(projectPath, 'files')
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
  window.kettu.app?.setUnsaved(files)
})
