import { create } from 'zustand'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { AgentId } from '@shared/agents'
import type { FileContent } from '@shared/files'
import type { FileDiff } from '@shared/git'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { isWithin, movedPath } from '@renderer/features/files/paths'
import { useGitStore } from './git'
import {
  changeDocs,
  closeDoc,
  docKey,
  keepDoc,
  openDoc,
  panelOf,
  shownDoc,
  useViewStore,
  type DocTab,
  type OpenDocOptions,
} from './view'
import { focusedPane } from '@renderer/features/split/layout'

export interface ProjectFiles {
  paths: string[]
  /** Folders with nothing in them, which no path in `paths` names. */
  folders: string[]
  /** The same paths, for telling whether a reference in a reply names a file. */
  known: ReadonlySet<string>
  truncated: boolean
  error: string | null
}

/** Files and folders cut or copied in a project's tree, for pasting in the same project. */
export interface FileClipboard {
  projectPath: string
  paths: string[]
  cut: boolean
}

export interface OpenFile {
  /** Relative to the project, or absolute for a file of the session agent's own folder. */
  path: string
  /** For a file of that folder, the session it belongs to, read through it and never written. */
  agent?: { sessionId: string; agentId: AgentId }
  /** The line to show and mark, from a reference such as `src/x.ts:12`. */
  line: number | null
  /** Counts requests to show `line`, so the editor jumps once per request, not on every visit. */
  jump: number
  content: FileContent | null
  error: string | null
  /** The last read failed because the file is no longer on disk; read only with `error`. */
  missing: boolean
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

/** A file's change, in the working tree or at a commit, which a diff tab shows. */
export interface DiffTarget {
  /** Relative to the repository root, as git names it. */
  path: string
  oldPath: string | null
  /** The commit, or null for the working tree against HEAD. */
  ref: string | null
  /** The same file as the Files pane names it, or null when it lies outside the project. */
  projectFile: string | null
}

/** What a diff tab has read of its change. */
export interface DiffView {
  result: FileDiff | null
  error: string | null
}

/** The file tab that asks "Save changes?" before it closes, in the panel it closes in. */
export interface PendingClose {
  projectPath: string
  panel: string
  path: string
}

interface FilesStore {
  byProject: Record<string, ProjectFiles>
  /** By project, the files its sessions' file tabs show, with what was read of each. */
  open: Record<string, OpenFile[]>
  /** Markdown files show their source instead of the rendered preview, for every file. */
  markdownSource: boolean
  /** SVG files show their source instead of the picture, for every file. */
  svgSource: boolean
  /** The tab that asks first because it has unsaved edits. */
  pending: PendingClose | null
  /** By `diffKey`, what the diff tabs of a project's sessions have read. */
  diffs: Record<string, DiffView>
  /** By `agentFolderKey`, the folder a session's agent keeps its own files in, null for none. */
  agentFolders: Record<string, string | null>
  clipboard: FileClipboard | null
}

export const useFilesStore = create<FilesStore>()(() => ({
  byProject: {},
  open: {},
  markdownSource: false,
  svgSource: false,
  pending: null,
  diffs: {},
  agentFolders: {},
  clipboard: null,
}))

/** A session's agent folder is asked for again when the session moves to another agent. */
export const agentFolderKey = (sessionId: string, agentId: AgentId): string =>
  `${sessionId}\0${agentId}`

const askedFolders = new Set<string>()

/** Asks the session's host once for its agent's own folder, which `agentFolders` then holds. */
export function ensureAgentFolder(sessionId: string, agentId: AgentId): void {
  const key = agentFolderKey(sessionId, agentId)
  if (askedFolders.has(key)) return
  askedFolders.add(key)
  host('files.agentFolder', { sessionId }).then(
    (folder) =>
      useFilesStore.setState((s) => ({ agentFolders: { ...s.agentFolders, [key]: folder } })),
    // Asked again by the next reply that names a file outside the project.
    () => askedFolders.delete(key),
  )
}

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

/** By project, how many views show its list now: the Files pane and an open `@` mention list. */
const watchers = new Map<string, number>()

/** Projects whose working tree changed since their list was read, while nothing showed it. */
const staleLists = new Set<string>()

const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((path, i) => path === b[i])

/** Lists the project's files; one request at a time per project. */
export function loadFiles(projectPath: string): Promise<void> {
  const running = inFlight.get(projectPath)
  if (running) return running
  staleLists.delete(projectPath)
  const request = host('files.list', { projectPath })
    .then(({ paths, folders = [], truncated }): ProjectFiles => {
      // An unchanged list keeps its arrays, so nothing that indexes them works again.
      const before = useFilesStore.getState().byProject[projectPath]
      if (before && !before.error && before.truncated === truncated) {
        if (samePaths(before.paths, paths) && samePaths(before.folders, folders)) return before
      }
      return { paths, folders, known: new Set(paths), truncated, error: null }
    })
    .catch((error: unknown) => {
      // A failed refresh keeps the list it had.
      const before = useFilesStore.getState().byProject[projectPath]
      return {
        paths: before?.paths ?? [],
        folders: before?.folders ?? [],
        known: before?.known ?? new Set<string>(),
        truncated: before?.truncated ?? false,
        error: errorMessage(error),
      }
    })
    .then((files) => {
      if (useFilesStore.getState().byProject[projectPath] === files) return
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

/** Lists the project's files unless they are known and nothing changed on disk since. */
export function ensureFreshFiles(projectPath: string): void {
  if (!useFilesStore.getState().byProject[projectPath] || staleLists.has(projectPath)) {
    void loadFiles(projectPath)
  }
}

/**
 * Keeps the project's list current while a view shows it: read now if it is unknown or stale,
 * then again after each change on disk. Returns the call that stops watching.
 */
export function watchFiles(projectPath: string): () => void {
  watchers.set(projectPath, (watchers.get(projectPath) ?? 0) + 1)
  if (!useFilesStore.getState().byProject[projectPath]) void loadFiles(projectPath)
  else if (staleLists.has(projectPath)) refreshFiles(projectPath)
  return () => {
    const count = (watchers.get(projectPath) ?? 1) - 1
    if (count > 0) watchers.set(projectPath, count)
    else watchers.delete(projectPath)
  }
}

function fresh(path: string, line: number | null, content: FileContent | null): OpenFile {
  return {
    path,
    line,
    jump: line === null ? 0 : 1,
    content,
    error: null,
    missing: false,
    dirty: false,
    changedOnDisk: false,
    diskVersion: null,
    kept: null,
    saving: false,
    saveError: null,
    resets: 0,
  }
}

// The project each side panel works in, as its row and its opens say. A tab belongs to its panel,
// while a file's text and edits are the project's, shared by every panel that has it open.
const panelProjects = new Map<string, string>()

/** A side panel's word on the project it works in. */
export function notePanel(panel: string, projectPath: string): void {
  panelProjects.set(panel, projectPath)
}

const panelsOf = (projectPath: string): string[] =>
  [...panelProjects].flatMap(([panel, project]) => (project === projectPath ? [panel] : []))

/** Whether a panel of the project other than `except` has the tab. */
function heldElsewhere(projectPath: string, key: string, except: string): boolean {
  const { sideDocs } = useViewStore.getState()
  return panelsOf(projectPath).some(
    (panel) => panel !== except && sideDocs[panel]?.some((tab) => docKey(tab) === key),
  )
}

/** The side panel in view, when the pane in focus works in `projectPath`. */
function panelIn(projectPath: string): string | null {
  const view = focusedPane(useViewStore.getState().layout).view
  return view.projectPath === projectPath ? panelOf(view) : null
}

const filesOf = (projectPath: string): OpenFile[] =>
  useFilesStore.getState().open[projectPath] ?? NO_FILES
const NO_FILES: OpenFile[] = []

const findFile = (projectPath: string, path: string): OpenFile | undefined =>
  filesOf(projectPath).find((file) => file.path === path)

function setFiles(projectPath: string, files: OpenFile[]): void {
  useFilesStore.setState((s) => {
    const open = { ...s.open }
    if (files.length > 0) open[projectPath] = files
    else delete open[projectPath]
    return { open }
  })
}

export const diffKey = (projectPath: string, id: string): string => `${projectPath}\0${id}`

/** A diff tab's id within its panel: the commit, then the file. */
export const diffId = (target: Pick<DiffTarget, 'path' | 'ref'>): string =>
  `${target.ref ?? ''}:${target.path}`

/** Forgets what a closed tab read, unless another panel of the project still has the tab. */
function release(panel: string, projectPath: string, tab: DocTab): void {
  if (tab.kind === 'artifact' || tab.kind === 'plugin') return
  if (heldElsewhere(projectPath, docKey(tab), panel)) return
  if (tab.kind === 'file') {
    dropBuffer(projectPath, tab.id)
    setFiles(
      projectPath,
      filesOf(projectPath).filter((file) => file.path !== tab.id),
    )
  } else {
    useFilesStore.setState((s) => {
      const diffs = { ...s.diffs }
      delete diffs[diffKey(projectPath, tab.id)]
      return { diffs }
    })
  }
}

/** Takes a file or diff tab off the panel's row, with what it read. */
export function closeFileDoc(panel: string, projectPath: string, tab: DocTab): void {
  closeDoc(panel, docKey(tab))
  release(panel, projectPath, tab)
}

/**
 * Shows a file in a tab of the side panel in view, scrolled to `line` if given: the tab it has, or
 * for a `preview` open the preview tab's place, else a new tab.
 */
export function openFile(
  projectPath: string,
  path: string,
  line: number | null = null,
  options: OpenDocOptions & { agent?: OpenFile['agent'] } = {},
): void {
  const panel = panelIn(projectPath)
  if (!panel) return
  notePanel(panel, projectPath)
  const { agent, ...place } = options
  const replaced = openDoc(panel, { kind: 'file', id: path, ...(agent && { agent }) }, place)
  if (replaced) release(panel, projectPath, replaced)
  if (findFile(projectPath, path)) {
    update(projectPath, path, (file) => ({ line, jump: line === null ? file.jump : file.jump + 1 }))
  } else {
    setFiles(projectPath, [
      ...filesOf(projectPath),
      { ...fresh(path, line, null), ...(agent && { agent }) },
    ])
  }
  void readOpenFile(projectPath, path)
}

/** Reads the file a tab shows, as when the tab is selected or comes back after a restart. */
export function showOpenFile(projectPath: string, tab: Extract<DocTab, { kind: 'file' }>): void {
  const file = findFile(projectPath, tab.id)
  if (!file) {
    setFiles(projectPath, [
      ...filesOf(projectPath),
      { ...fresh(tab.id, null, null), ...(tab.agent && { agent: tab.agent }) },
    ])
  } else if (!file.content && !file.error) {
    // Its first read is on its way.
    return
  }
  void readOpenFile(projectPath, tab.id)
}

/**
 * The tabs of files that moved follow them, with their edits, undo history and place: each move
 * takes a file or a folder from `from` to `to`, and what was in a folder with it.
 */
export function followMoves(projectPath: string, moves: readonly { from: string; to: string }[]) {
  const files = filesOf(projectPath)
  if (moves.length === 0) return
  const moved = (path: string) => {
    const move = moves.find(({ from }) => isWithin(path, from))
    return move ? movedPath(path, move.from, move.to) : path
  }
  for (const panel of panelsOf(projectPath)) {
    changeDocs(panel, (tab) =>
      tab.kind === 'file' && !tab.agent && moved(tab.id) !== tab.id
        ? { ...tab, id: moved(tab.id) }
        : tab,
    )
  }
  if (!files.some((file) => moved(file.path) !== file.path)) return
  for (const file of files) {
    const to = moved(file.path)
    const buffer = getBuffer(projectPath, file.path)
    if (to === file.path || !buffer) continue
    // The same buffer, which its editor state's listener writes to, under its new path.
    dropBuffer(projectPath, file.path)
    buffer.path = to
    putBuffer(projectPath, buffer)
  }
  setFiles(
    projectPath,
    files.map((file) => {
      const path = moved(file.path)
      if (path === file.path) return file
      return { ...file, path, content: file.content && { ...file.content, path } }
    }),
  )
  const pending = useFilesStore.getState().pending
  if (pending?.projectPath === projectPath) {
    useFilesStore.setState({ pending: { ...pending, path: moved(pending.path) } })
  }
}

/** The open files at or under `paths` that hold unsaved edits. */
export function unsavedUnder(projectPath: string, paths: readonly string[]): string[] {
  return filesOf(projectPath)
    .filter((file) => file.dirty && paths.some((path) => isWithin(file.path, path)))
    .map((file) => file.path)
}

/** Closes the tabs of files that were deleted, or were in a deleted folder, edits and all. */
export function closeRemoved(projectPath: string, paths: readonly string[]): void {
  const gone = (path: string) => paths.some((removed) => isWithin(path, removed))
  const { sideDocs } = useViewStore.getState()
  for (const panel of panelsOf(projectPath)) {
    for (const tab of sideDocs[panel] ?? []) {
      if (tab.kind === 'file' && !tab.agent && gone(tab.id)) closeDoc(panel, docKey(tab))
    }
  }
  const files = filesOf(projectPath)
  for (const file of files) if (!file.agent && gone(file.path)) dropBuffer(projectPath, file.path)
  setFiles(
    projectPath,
    files.filter((file) => file.agent || !gone(file.path)),
  )
}

/**
 * Whether closing the panel's tab of the file asks first: it has unsaved edits that no other
 * panel's tab would keep. Asks "Save changes?" when it does.
 */
export function asksBeforeClose(panel: string, projectPath: string, path: string): boolean {
  if (!findFile(projectPath, path)?.dirty) return false
  if (heldElsewhere(projectPath, `file:${path}`, panel)) return false
  useFilesStore.setState({ pending: { projectPath, panel, path } })
  return true
}

/** The answer to "Save changes?"; the tab to close, unless it is cancelled or the save fails. */
export async function answerPending(
  answer: 'cancel' | 'discard' | 'save',
): Promise<PendingClose | null> {
  const change = useFilesStore.getState().pending
  useFilesStore.setState({ pending: null })
  if (!change || answer === 'cancel') return null
  if (answer === 'save' && !(await saveFile(change.projectPath, change.path))) return null
  return change
}

/** Changes the open file `path` if it is still open. */
function update(
  projectPath: string,
  path: string,
  change: Partial<OpenFile> | ((file: OpenFile) => Partial<OpenFile>),
): void {
  const files = filesOf(projectPath)
  const index = files.findIndex((file) => file.path === path)
  if (index < 0) return
  const now = files[index]!
  setFiles(
    projectPath,
    files.with(index, { ...now, ...(typeof change === 'function' ? change(now) : change) }),
  )
}

/** The editor's word on whether its text differs from the file it started from. */
export function setDirty(projectPath: string, path: string, dirty: boolean): void {
  if (findFile(projectPath, path)?.dirty === dirty) return
  update(projectPath, path, { dirty, saveError: null })
  // A file with unsaved edits is never the preview tab, which the next click would replace.
  if (dirty) for (const panel of panelsOf(projectPath)) keepDoc(panel, `file:${path}`)
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
  const file = findFile(projectPath, path)
  if (!file) return
  const { agent } = file
  const asText = !agent && readsSource(path)
  try {
    const content = agent
      ? await host('files.readAgentFile', { sessionId: agent.sessionId, path })
      : await host('files.read', { projectPath, path, ...(asText && { asText }) })
    update(projectPath, path, (now) => {
      // The choice of an SVG's picture or source changed meanwhile, and its own read follows.
      if (!now.agent && readsSource(path) !== asText) return {}
      const buffer = getBuffer(projectPath, path)
      if (!renew && sameMedia(now.content, content)) return { error: null }
      // An SVG's picture has no text to set the edits against; they wait for its source.
      if (!now.dirty || !buffer || content.kind === 'media') {
        return { content, error: null }
      }
      // Back from the picture, the source shows, and the bar says if it changed.
      const shown = now.content?.kind === 'media' ? { content, error: null } : { error: null }
      const version = content.kind === 'text' ? content.version : null
      if (version === buffer.version || (version !== null && version === now.kept)) return shown
      return { ...shown, changedOnDisk: true, diskVersion: version, error: null }
    })
  } catch (error) {
    update(projectPath, path, {
      error: errorMessage(error),
      missing: errorCode(error) === 'not_found',
    })
  }
}

/** Reads an open file again after a read failed. */
export function readAgain(projectPath: string, path: string): void {
  void readOpenFile(projectPath, path)
}

/** Shows every SVG as its source, or as its picture, until changed; open ones are read again. */
export function showSvgSource(source: boolean): void {
  useFilesStore.setState({ svgSource: source })
  for (const [projectPath, files] of Object.entries(useFilesStore.getState().open)) {
    for (const file of files) if (isSvgFile(file.path)) void readOpenFile(projectPath, file.path)
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
  if (!file?.dirty || !buffer || file.agent) return true
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
  return Object.entries(useFilesStore.getState().open).flatMap(([projectPath, files]) =>
    files.filter((file) => file.dirty).map((file) => ({ projectPath, path: file.path })),
  )
}

/** Saves every file with unsaved edits; false when any is still unsaved. */
export async function saveAll(): Promise<boolean> {
  const results = await Promise.all(unsavedFiles().map((f) => saveFile(f.projectPath, f.path)))
  return results.every(Boolean)
}

/** Lists the files and reads what the shown tab has again, after a change on disk or on focus. */
export function refreshFiles(projectPath: string): void {
  const view = useViewStore.getState()
  const shown = new Map<string, DocTab>()
  for (const panel of panelsOf(projectPath)) {
    const tab = shownDoc(view, panel)
    if (tab) shown.set(docKey(tab), tab)
  }
  for (const tab of shown.values()) {
    // The working tree's side of a diff changes with the files.
    if (tab.kind === 'diff' && tab.ref === null) void readDiff(projectPath, tab)
    else if (tab.kind === 'file') void readOpenFile(projectPath, tab.id)
  }
  if (useFilesStore.getState().byProject[projectPath]) void loadFiles(projectPath)
}

async function readDiff(projectPath: string, target: DiffTarget): Promise<void> {
  const key = diffKey(projectPath, diffId(target))
  const settle = (change: Partial<DiffView>): void =>
    useFilesStore.setState((s) =>
      s.diffs[key] ? { diffs: { ...s.diffs, [key]: { ...s.diffs[key], ...change } } } : {},
    )
  try {
    const { path, oldPath, ref } = target
    settle({ result: await host('git.fileDiff', { projectPath, path, oldPath, ref }), error: null })
  } catch (error) {
    settle({ error: errorMessage(error) })
  }
}

/** Reads the change a diff tab shows, keeping what it read before until the new one arrives. */
export function showOpenDiff(projectPath: string, target: DiffTarget): void {
  const key = diffKey(projectPath, diffId(target))
  if (!useFilesStore.getState().diffs[key]) {
    useFilesStore.setState((s) => ({ diffs: { ...s.diffs, [key]: { result: null, error: null } } }))
  }
  void readDiff(projectPath, target)
}

/**
 * Shows a file's change in a diff tab of the side panel in view: the tab it has, or for a
 * `preview` open the preview tab's place, else a new tab.
 */
export function openDiff(projectPath: string, target: DiffTarget, options?: OpenDocOptions): void {
  const panel = panelIn(projectPath)
  if (!panel) return
  notePanel(panel, projectPath)
  const { path, oldPath, ref, projectFile } = target
  const replaced = openDoc(
    panel,
    { kind: 'diff', id: diffId(target), path, oldPath, ref, projectFile },
    options,
  )
  if (replaced) release(panel, projectPath, replaced)
  showOpenDiff(projectPath, target)
}

// A new git status means the working tree changed, after an agent's edit as after one of yours,
// or the window came back into focus; a burst of them refreshes once. Only a list a view shows is
// read again; the others wait until one shows them.
const REFRESH_DELAY_MS = 300
const timers = new Map<string, ReturnType<typeof setTimeout>>()
useGitStore.subscribe((state, previous) => {
  for (const [projectPath, status] of Object.entries(state.status)) {
    if (status === previous.status[projectPath]) continue
    if (!watchers.has(projectPath)) {
      if (useFilesStore.getState().byProject[projectPath]) staleLists.add(projectPath)
      continue
    }
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
