import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  DragDropProvider,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/react'
import {
  ArrowRight01Icon,
  AtIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Delete02Icon,
  FileAddIcon,
  FilePasteIcon,
  FolderAddIcon,
  FolderOpenIcon,
  Link01Icon,
  PencilEdit02Icon,
  Scissor01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ChangeStatus } from '@shared/git'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { toast } from '@renderer/components/ui/toast'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName, formatShortcut, isMac, isMod } from '@renderer/lib/platform'
import { openFile, unsavedUnder, useFilesStore, type ProjectFiles } from '@renderer/stores/files'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { panelSession } from '@renderer/stores/view'
import { ChangeBadge } from './change-badge'
import { columnOf, NO_PATHS, saveColumn } from './column'
import { DeletePrompt, type Deleting } from './delete-prompt'
import { FileTypeIcon } from './file-type-icon'
import { mentionPaths } from './mention-lines'
import {
  copyEntries,
  copyPaths,
  createEntry,
  deleteEntries,
  folderFor,
  hostFilePath,
  moveEntries,
  openTerminalIn,
  pasteInto,
  putOnClipboard,
  renameEntry,
} from './operations'
import {
  folderOf,
  foldersAbove,
  indexFolders,
  isWithin,
  joinPath,
  movedPath,
  nameOf,
  outermost,
  treeRows,
  type TreeRow,
} from './paths'
import { VirtualRows, type RowKey } from './virtual-rows'

// A single click in a list opens the preview tab, which the next single click replaces.
const PREVIEW = { preview: true, fromPanel: true }
const KEPT = { fromPanel: true }
// Where the row of a new file or folder's name stands in the list.
const DRAFT = '\0new'

/** A name being typed in the tree: a new file or folder in `folder`, or a row's new name. */
export type TreeEdit =
  { kind: 'new'; folder: string; type: 'file' | 'folder' } | { kind: 'rename'; path: string }

type Line = TreeRow & { draft?: boolean }

// A press that moves the mouse starts a drag; a press held in place is still a click.
const pointerDefaults = PointerSensor.defaults.activationConstraints
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event, source) => {
      const constraints =
        typeof pointerDefaults === 'function' ? pointerDefaults(event, source) : pointerDefaults
      return event.pointerType === 'mouse' ? constraints?.slice(1) : constraints
    },
  }),
]

// A list's folders and files, worked out once while the list lives.
const folderIndexes = new WeakMap<ProjectFiles, ReturnType<typeof indexFolders>>()

function folderIndex(files: ProjectFiles): ReturnType<typeof indexFolders> {
  let index = folderIndexes.get(files)
  if (!index) {
    index = indexFolders(files.paths, files.folders)
    folderIndexes.set(files, index)
  }
  return index
}

/** Where a new row goes among `rows`: a folder first under its parent, a file after the folders. */
function draftAt(rows: readonly TreeRow[], parent: number, depth: number, file: boolean): number {
  let at = parent + 1
  if (!file) return at
  while (at < rows.length && rows[at]!.depth >= depth) {
    if (rows[at]!.depth === depth && !rows[at]!.folder) return at
    at++
  }
  return at
}

/** The rows with the row of a new file's or folder's name among them, inside its folder. */
function withDraft(rows: TreeRow[], adding: Extract<TreeEdit, { kind: 'new' }> | null): Line[] {
  if (!adding) return rows
  const { folder, type } = adding
  const parent = folder === '' ? -1 : rows.findIndex((row) => row.path === folder)
  if (folder !== '' && parent < 0) return rows
  const depth = parent < 0 ? 0 : rows[parent]!.depth + 1
  const at = draftAt(rows, parent, depth, type === 'file')
  const draft: Line = { path: DRAFT, depth, folder: type === 'folder', draft: true }
  return [...rows.slice(0, at), draft, ...rows.slice(at)]
}

/** The path a typed name gives inside `folder`, or why it cannot be one. */
function typedPath(
  typed: string,
  folder: string,
): { path: string } | { problem: 'invalid' } | null {
  const segments = typed
    .trim()
    .split(/[\\/]/)
    .filter((segment) => segment !== '')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '.' || segment === '..' || segment === '.git')) {
    return { problem: 'invalid' }
  }
  return { path: joinPath(folder, segments.join('/')) }
}

/** What the tree is for a project: its folders and files, open or not, and what one does to them. */
export function FileTree({
  projectPath,
  panel,
  columnKey,
  files,
  openPath,
  changes,
  local,
  edit,
  onEdit,
  collapsed,
}: {
  projectPath: string
  /** The side panel the pane shows in, whose session a mention goes to. */
  panel: string
  columnKey: string
  files: ProjectFiles
  openPath: string | undefined
  changes: ReadonlyMap<string, ChangeStatus>
  /** The project is on this computer, so the file manager reaches it. */
  local: boolean
  edit: TreeEdit | null
  onEdit: (edit: TreeEdit | null) => void
  /** Counts Collapse all, which closes every folder. */
  collapsed: number
}) {
  const { t } = useTranslation(['files', 'common', 'composer'])
  const index = folderIndex(files)
  const isFolder = (path: string) => index.has(path)
  const [expanded, setExpanded] = useState(() => columnOf(columnKey).expanded)
  const [selected, setSelected] = useState(() => columnOf(columnKey).selected)
  const [anchor, setAnchor] = useState(() => columnOf(columnKey).anchor)
  // A file opened from the conversation shows in the tree, its folders opened, and chosen.
  const [revealed, setRevealed] = useState(() => columnOf(columnKey).revealed)
  if (openPath !== revealed) {
    setRevealed(openPath)
    // An agent's own file, by its absolute path, is in no folder of the tree.
    if (openPath && !/^(?:\/|[a-z]:[\\/])/i.test(openPath)) {
      setExpanded(new Set([...expanded, ...foldersAbove(openPath)]))
      setSelected(new Set([openPath]))
      setAnchor(openPath)
    }
  }
  const [collapseSeen, setCollapseSeen] = useState(collapsed)
  if (collapsed !== collapseSeen) {
    setCollapseSeen(collapsed)
    setExpanded(NO_PATHS)
  }
  // A new name is typed inside its folder, which opens for it.
  const [editSeen, setEditSeen] = useState(edit)
  if (edit !== editSeen) {
    setEditSeen(edit)
    if (edit?.kind === 'new' && edit.folder !== '') {
      setExpanded(new Set([...expanded, ...foldersAbove(`${edit.folder}/`)]))
    }
  }
  const [initialScroll] = useState(() => columnOf(columnKey).scroll)
  useEffect(
    () => saveColumn(columnKey, { expanded, revealed, selected, anchor }),
    [columnKey, expanded, revealed, selected, anchor],
  )
  const clipboard = useFilesStore((s) =>
    s.clipboard?.projectPath === projectPath ? s.clipboard : null,
  )
  const cut = useMemo(() => new Set(clipboard?.cut ? clipboard.paths : []), [clipboard])
  const terminal = useTerminalAllowed(projectPath)
  const sessionId = panelSession(panel)

  const adding = edit?.kind === 'new' ? edit : null
  const rows = withDraft(treeRows(index, expanded), adding)
  const openIndex = openPath ? rows.findIndex((r) => r.path === openPath) : -1

  // The row to focus once the list shows it, after a name was typed or files moved.
  const box = useRef<HTMLDivElement>(null)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  useEffect(() => {
    if (focusPath === null) return
    const row = box.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusPath)}"]`)
    if (!row) return
    row.focus()
    setFocusPath(null)
  }, [focusPath, rows])
  const focusIndex = focusPath === null ? -1 : rows.findIndex((r) => r.path === focusPath)

  const toggle = (folder: string, open = !expanded.has(folder)) => {
    if (open === expanded.has(folder)) return
    const next = new Set(expanded)
    if (open) next.add(folder)
    else next.delete(folder)
    setExpanded(next)
  }

  const choose = (paths: readonly string[], from: string | null = paths[0] ?? null) => {
    setSelected(new Set(paths))
    setAnchor(from)
  }

  /** The chosen paths in the order the tree shows them. */
  const chosen = (): string[] => {
    const shown = rows.filter((row) => selected.has(row.path)).map((row) => row.path)
    return [...shown, ...[...selected].filter((path) => !shown.includes(path))]
  }

  /** What an action on `path` acts on: the chosen rows when it is one of them, else itself. */
  const targetsOf = (path: string | null): string[] =>
    path === null ? [] : selected.has(path) ? chosen() : [path]

  const rangeTo = (path: string): string[] => {
    const from = anchor === null ? -1 : rows.findIndex((row) => row.path === anchor)
    const to = rows.findIndex((row) => row.path === path)
    if (from < 0 || to < 0) return [path]
    const [low, high] = from <= to ? [from, to] : [to, from]
    return rows.slice(low, high + 1).flatMap((row) => (row.draft ? [] : [row.path]))
  }

  const onRowClick = (row: Line, event: MouseEvent) => {
    if (isMod(event)) {
      const next = new Set(selected)
      if (next.has(row.path)) next.delete(row.path)
      else next.add(row.path)
      setSelected(next)
      setAnchor(row.path)
      return
    }
    if (event.shiftKey) {
      setSelected(new Set(rangeTo(row.path)))
      return
    }
    choose([row.path])
    if (row.folder) toggle(row.path)
    else openFile(projectPath, row.path, null, PREVIEW)
  }

  // The arrow keys move the choice with the focus, and with Shift reach from the anchor.
  const moving = useRef<{ shift: boolean } | null>(null)
  const onRowFocus = (row: Line) => {
    const move = moving.current
    moving.current = null
    if (!move || row.draft) return
    if (move.shift) setSelected(new Set(rangeTo(row.path)))
    else choose([row.path])
  }

  // ArrowRight opens a folder, then goes into it; ArrowLeft closes it, then goes to its parent.
  const onRowKey: RowKey = (i, event) => {
    const row = rows[i]
    if (!row) return null
    if (event.key === 'ArrowRight') {
      if (!row.folder) return null
      if (!expanded.has(row.path)) {
        toggle(row.path, true)
        return i
      }
      return rows[i + 1]?.depth === row.depth + 1 ? i + 1 : i
    }
    if (event.key === 'ArrowLeft') {
      if (row.folder && expanded.has(row.path)) {
        toggle(row.path, false)
        return i
      }
      const parent = folderOf(row.path)
      const at = parent ? rows.findIndex((r) => r.path === parent) : -1
      return at >= 0 ? at : i
    }
    return null
  }

  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const askDelete = (paths: string[]) => {
    if (paths.length === 0) return
    const outer = outermost(paths)
    setDeleting({ paths: outer, permanently: false, unsaved: unsavedUnder(projectPath, outer) })
  }
  const answerDelete = async (confirmed: boolean) => {
    const asked = deleting
    setDeleting(null)
    if (!confirmed || !asked) return
    const outcome = await deleteEntries(projectPath, asked.paths, asked.permanently)
    if (outcome === 'no-trash') setDeleting({ ...asked, permanently: true })
    else if (outcome === 'done') setSelected(NO_PATHS)
  }

  /**
   * Expands the folders above the paths, chooses them and focuses the first. Open folders that
   * `moves` took elsewhere stay open there.
   */
  const showPaths = (paths: string[], moves: readonly { from: string; to: string }[] = []) => {
    if (paths.length === 0) return
    const open = [...expanded].map((folder) => {
      const move = moves.find(({ from }) => isWithin(folder, from))
      return move ? movedPath(folder, move.from, move.to) : folder
    })
    setExpanded(new Set([...open, ...paths.flatMap((path) => foldersAbove(path))]))
    choose(paths)
    setFocusPath(paths[0]!)
  }

  /** What went where when `paths` moved into `folder` and arrived as `arrived`. */
  const movesOf = (paths: readonly string[], folder: string, arrived: readonly string[]) =>
    outermost(paths).flatMap((from) => {
      const to = joinPath(folder, nameOf(from))
      return arrived.includes(to) ? [{ from, to }] : []
    })

  const paste = async (folder: string) => {
    if (!clipboard) return
    const arrived = await pasteInto(projectPath, folder)
    showPaths(arrived, clipboard.cut ? movesOf(clipboard.paths, folder, arrived) : [])
  }

  const reveal = (path: string) =>
    void window.kettu.shell
      .showItem(hostFilePath(projectPath, path))
      .catch((failure: unknown) => toast(errorMessage(failure)))

  const mention = (paths: string[]) => {
    if (!sessionId) return
    const missed = mentionPaths(
      sessionId,
      projectPath,
      paths.map((path) => ({ path, folder: isFolder(path) })),
    )
    if (missed === 'no-composer') toast(t('tree.noComposer'))
    else if (missed === 'full') toast(t('composer:attachments.limit'))
  }

  const startRename = (path: string) => onEdit({ kind: 'rename', path })

  const finishEdit = async (typed: string | null) => {
    const current = edit
    onEdit(null)
    if (!current || typed === null) {
      box.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
      return
    }
    if (current.kind === 'new') {
      const target = typedPath(typed, current.folder)
      if (!target || 'problem' in target) return
      if (await createEntry(projectPath, target.path, current.type)) showPaths([target.path])
      return
    }
    const target = typedPath(typed, folderOf(current.path))
    if (!target || 'problem' in target || target.path === current.path) {
      setFocusPath(current.path)
      return
    }
    if (await renameEntry(projectPath, current.path, target.path)) {
      showPaths([target.path], [{ from: current.path, to: target.path }])
    } else setFocusPath(current.path)
  }

  /** Why a typed name cannot be used, as the field says while it is typed. */
  const nameProblem = (typed: string): string | null => {
    const folder =
      edit?.kind === 'new' ? edit.folder : edit?.kind === 'rename' ? folderOf(edit.path) : ''
    const target = typedPath(typed, folder)
    if (!target) return null
    if ('problem' in target) return t('tree.nameInvalid')
    const own = edit?.kind === 'rename' ? edit.path : null
    // Only a change of case names the row itself, which the host renames.
    if (own !== null && target.path.toLowerCase() === own.toLowerCase()) return null
    if (files.known.has(target.path) || index.has(target.path)) {
      return t('tree.nameTaken', { name: nameOf(target.path) })
    }
    return null
  }

  const focusedPath = (): string | null => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !box.current?.contains(active)) return null
    const path = active.closest<HTMLElement>('[data-path]')?.dataset.path
    return path === undefined || path === DRAFT ? null : path
  }

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const navigation = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
    moving.current =
      navigation.includes(event.key) && !event.altKey && !event.metaKey && !event.ctrlKey
        ? { shift: event.shiftKey }
        : null
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return
    const focused = focusedPath()
    const targets = targetsOf(focused)
    const mod = isMod(event)
    const plainMod = mod && !event.altKey && !event.shiftKey
    const run = (action: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    if (event.key === 'F2' && !mod && targets.length === 1)
      return run(() => startRename(targets[0]!))
    if ((event.key === 'Delete' && !mod) || (event.key === 'Backspace' && plainMod)) {
      if (targets.length > 0) run(() => askDelete(targets))
      return
    }
    if (plainMod && event.code === 'KeyA') {
      return run(() =>
        choose(
          rows.flatMap((row) => (row.draft ? [] : [row.path])),
          anchor,
        ),
      )
    }
    if (plainMod && (event.code === 'KeyC' || event.code === 'KeyX') && targets.length > 0) {
      return run(() => putOnClipboard(projectPath, targets, event.code === 'KeyX'))
    }
    if (plainMod && event.code === 'KeyV' && clipboard) {
      return run(() => void paste(folderFor(focused, focused !== null && isFolder(focused))))
    }
    if (mod && event.altKey && event.code === 'KeyC' && targets.length > 0) {
      return run(() => copyPaths(projectPath, targets, event.shiftKey))
    }
    if (mod && event.altKey && !event.shiftKey && event.code === 'KeyR' && local) {
      return run(() => reveal(targets[0] ?? ''))
    }
    if (event.key === 'Escape' && clipboard?.cut) {
      return run(() => useFilesStore.setState({ clipboard: null }))
    }
  }

  // The context menu's row, or null for the tree's empty room; an action waiting for it to close.
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const afterMenu = useRef<(() => void) | null>(null)
  // Whether the item chosen last moves the focus itself, so the closing menu leaves it alone; the
  // menu unmounts after it ran, so this lasts until the menu opens again.
  const keepsFocus = useRef(false)
  const queue = (action: () => void) => {
    afterMenu.current = action
    keepsFocus.current = true
  }
  const onContextMenu = (event: MouseEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-path]')
    const path = row?.dataset.path ?? null
    if (path === DRAFT || edit !== null) return
    keepsFocus.current = false
    setMenuPath(path)
    if (path !== null && !selected.has(path)) choose([path])
  }

  // Drag and drop: the rows dragged, and the folder they would go into ('' for the project's).
  const [dragged, setDragged] = useState<string[] | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const inTree = (point: { x: number; y: number }) => {
    const rect = box.current?.getBoundingClientRect()
    return (
      !!rect &&
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    )
  }
  const folderUnder = (event: DragMoveEvent | DragEndEvent): string | null => {
    const target = event.operation.target?.data as { folder?: string } | undefined
    if (target?.folder !== undefined) return target.folder
    return inTree(event.operation.position.current) ? '' : null
  }
  /** Whether the dragged rows may go into `folder`: never a folder into itself. */
  const canDrop = (paths: readonly string[], folder: string) =>
    !paths.some((path) => isFolder(path) && isWithin(folder, path))
  const onDragStart = (event: DragStartEvent) => {
    const path = (event.operation.source?.data as { path?: string } | undefined)?.path
    if (path === undefined) return
    const paths = selected.has(path) ? chosen() : [path]
    if (!selected.has(path)) choose([path])
    setDragged(outermost(paths))
  }
  const onDragMove = (event: DragMoveEvent) => {
    const folder = folderUnder(event)
    setDropFolder(folder !== null && dragged && canDrop(dragged, folder) ? folder : null)
  }
  const onDragEnd = (event: DragEndEvent) => {
    const paths = dragged
    const folder = folderUnder(event)
    setDragged(null)
    setDropFolder(null)
    if (event.canceled || !paths || folder === null || !canDrop(paths, folder)) return
    const copy = !!(event.nativeEvent as globalThis.MouseEvent | undefined)?.altKey
    if (copy) void copyEntries(projectPath, paths, folder).then((copies) => showPaths(copies))
    else {
      void moveEntries(projectPath, paths, folder).then((arrived) =>
        showPaths(arrived, movesOf(paths, folder, arrived)),
      )
    }
  }

  const menuTargets = targetsOf(menuPath)
  const menuFolder = folderFor(menuPath, menuPath !== null && isFolder(menuPath))
  const shortcut = (keys: string) => (
    <ContextMenuShortcut>{formatShortcut(keys)}</ContextMenuShortcut>
  )

  return (
    <DragDropProvider
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
    >
      <ContextMenu
        disabled={edit !== null}
        // A field to type a name in waits for the menu to close, which holds the focus till then.
        onOpenChangeComplete={(open) => {
          const action = afterMenu.current
          if (open || !action) return
          afterMenu.current = null
          action()
        }}
      >
        <ContextMenuTrigger
          ref={box}
          className="kp-tree select-none"
          data-drop={dropFolder === '' || undefined}
          onContextMenu={onContextMenu}
          onKeyDownCapture={onKeyDownCapture}
          onKeyDown={onKeyDown}
        >
          {rows.length === 0 ? (
            <p className="kp-tree__note">{t('browser.empty')}</p>
          ) : (
            <VirtualRows
              count={rows.length}
              scrollTo={focusIndex >= 0 ? focusIndex : openIndex < 0 ? null : openIndex}
              className="kp-tree__rows"
              initialScroll={initialScroll}
              onScrollTop={(scroll) => saveColumn(columnKey, { scroll })}
              roving
              onRowKey={onRowKey}
              role="tree"
              label={t('panel.title')}
            >
              {(i, tabIndex) => {
                const row = rows[i]!
                const editing =
                  row.draft || (edit?.kind === 'rename' && edit.path === row.path) ? edit : null
                if (editing) {
                  return (
                    <NameRow
                      key={row.path}
                      row={row}
                      initial={editing.kind === 'rename' ? nameOf(row.path) : ''}
                      label={
                        editing.kind === 'rename'
                          ? t('tree.renameLabel', { name: nameOf(row.path) })
                          : t(row.folder ? 'tree.newFolderLabel' : 'tree.newFileLabel')
                      }
                      problem={nameProblem}
                      onFinish={(typed) => void finishEdit(typed)}
                    />
                  )
                }
                return (
                  <TreeItem
                    key={row.path}
                    row={row}
                    tabIndex={tabIndex}
                    open={expanded.has(row.path)}
                    current={row.path === openPath}
                    chosen={selected.has(row.path)}
                    cut={[...cut].some((path) => isWithin(row.path, path))}
                    drop={
                      dropFolder !== null && dropFolder !== '' && isWithin(row.path, dropFolder)
                    }
                    change={row.folder ? undefined : changes.get(row.path)}
                    onClick={(event) => onRowClick(row, event)}
                    onDoubleClick={
                      row.folder ? undefined : () => openFile(projectPath, row.path, null, KEPT)
                    }
                    onFocus={() => onRowFocus(row)}
                  />
                )
              }}
            </VirtualRows>
          )}
        </ContextMenuTrigger>
        {/* The menu leaves the focus alone for what takes it once it closes. */}
        <ContextMenuContent className="min-w-56" finalFocus={() => !keepsFocus.current}>
          <ContextMenuItem
            onClick={() => queue(() => onEdit({ kind: 'new', folder: menuFolder, type: 'file' }))}
          >
            <PaneIcon icon={FileAddIcon} size={16} />
            {t('tree.newFile')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => queue(() => onEdit({ kind: 'new', folder: menuFolder, type: 'folder' }))}
          >
            <PaneIcon icon={FolderAddIcon} size={16} />
            {t('tree.newFolder')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {local && (
            <ContextMenuItem onClick={() => reveal(menuTargets[0] ?? '')}>
              <PaneIcon icon={FolderOpenIcon} size={16} />
              {t('preview.showIn', { name: fileManagerName() })}
              {shortcut('Alt+Mod+R')}
            </ContextMenuItem>
          )}
          {terminal && (
            <ContextMenuItem onClick={() => openTerminalIn(panel, menuFolder)}>
              <PaneIcon icon={ComputerTerminal01Icon} size={16} />
              {t('tree.openTerminal')}
            </ContextMenuItem>
          )}
          {sessionId && menuTargets.length > 0 && (
            <ContextMenuItem onClick={() => queue(() => mention(menuTargets))}>
              <PaneIcon icon={AtIcon} size={16} />
              {t('tree.mention')}
            </ContextMenuItem>
          )}
          {menuTargets.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => putOnClipboard(projectPath, menuTargets, true)}>
                <PaneIcon icon={Scissor01Icon} size={16} />
                {t('tree.cut')}
                {shortcut('Mod+X')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => putOnClipboard(projectPath, menuTargets, false)}>
                <PaneIcon icon={Copy01Icon} size={16} />
                {t('tree.copy')}
                {shortcut('Mod+C')}
              </ContextMenuItem>
            </>
          )}
          {clipboard && (
            <>
              {menuTargets.length === 0 && <ContextMenuSeparator />}
              <ContextMenuItem onClick={() => void paste(menuFolder)}>
                <PaneIcon icon={FilePasteIcon} size={16} />
                {t('tree.paste')}
                {shortcut('Mod+V')}
              </ContextMenuItem>
            </>
          )}
          {menuTargets.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => copyPaths(projectPath, menuTargets, false)}>
                <PaneIcon icon={Link01Icon} size={16} />
                {t('tree.copyPath')}
                {shortcut('Alt+Mod+C')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => copyPaths(projectPath, menuTargets, true)}>
                <PaneIcon icon={Link01Icon} size={16} />
                {t('tree.copyRelativePath')}
                {shortcut('Shift+Alt+Mod+C')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              {menuTargets.length === 1 && (
                <ContextMenuItem onClick={() => queue(() => startRename(menuTargets[0]!))}>
                  <PaneIcon icon={PencilEdit02Icon} size={16} />
                  {t('tree.rename')}
                  <ContextMenuShortcut>F2</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              <ContextMenuItem
                variant="destructive"
                onClick={() => queue(() => askDelete(menuTargets))}
              >
                <PaneIcon icon={Delete02Icon} size={16} />
                {t('tree.delete')}
                {shortcut(isMac ? 'Mod+Backspace' : 'Delete')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <DragOverlay dropAnimation={null}>
        {dragged && <DragChip paths={dragged} isFolder={isFolder} />}
      </DragOverlay>
      <DeletePrompt deleting={deleting} onAnswer={(confirmed) => void answerDelete(confirmed)} />
    </DragDropProvider>
  )
}

/** A folder's or file's row, which can be dragged, and dropped on into its folder. */
function TreeItem({
  row,
  tabIndex,
  open,
  current,
  chosen,
  cut,
  drop,
  change,
  onClick,
  onDoubleClick,
  onFocus,
}: {
  row: Line
  tabIndex: number | undefined
  open: boolean
  current: boolean
  chosen: boolean
  cut: boolean
  drop: boolean
  change: ChangeStatus | undefined
  onClick: (event: MouseEvent) => void
  onDoubleClick: (() => void) | undefined
  onFocus: () => void
}) {
  const drag = useDraggable({ id: `file:${row.path}`, data: { path: row.path } })
  const target = useDroppable({
    id: `into:${row.path}`,
    data: { folder: row.folder ? row.path : folderOf(row.path) },
  })
  return (
    <button
      ref={(element) => {
        drag.ref(element)
        target.ref(element)
      }}
      type="button"
      title={row.path}
      tabIndex={tabIndex}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onFocus={onFocus}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={chosen}
      aria-expanded={row.folder ? open : undefined}
      aria-current={current || undefined}
      data-path={row.path}
      data-chosen={chosen || undefined}
      data-cut={cut || undefined}
      data-drop={drop || undefined}
      style={{ paddingLeft: 8 + row.depth * 14 }}
      className={row.folder ? 'kp-node kp-node--dir' : 'kp-node'}
    >
      <Chevron folder={row.folder} />
      <FileTypeIcon path={row.path} folder={row.folder} open={open} className="size-4" />
      <span className="kp-node__name">
        <span>{nameOf(row.path)}</span>
      </span>
      {change && <ChangeBadge status={change} />}
    </button>
  )
}

function Chevron({ folder }: { folder: boolean }) {
  return (
    <span className="kp-node__chev">
      {folder && <PaneIcon icon={ArrowRight01Icon} size={12} />}
    </span>
  )
}

/**
 * A row whose name is typed: a new file's or folder's, or a row's new name. Enter or leaving the
 * field takes the name, unless it cannot be used; Esc drops it.
 */
function NameRow({
  row,
  initial,
  label,
  problem,
  onFinish,
}: {
  row: Line
  initial: string
  label: string
  problem: (typed: string) => string | null
  onFinish: (typed: string | null) => void
}) {
  const [value, setValue] = useState(initial)
  const finished = useRef(false)
  const shown = problem(value)
  const finish = (typed: string | null) => {
    if (finished.current) return
    finished.current = true
    onFinish(typed)
  }
  return (
    <div
      className="kp-node kp-node--edit"
      data-path={row.path}
      style={{ paddingLeft: 8 + row.depth * 14 }}
    >
      <Chevron folder={row.folder} />
      <FileTypeIcon
        path={value || (row.folder ? 'folder' : 'file')}
        folder={row.folder}
        className="size-4"
      />
      <input
        className="kp-node__input"
        aria-label={label}
        aria-invalid={shown !== null || undefined}
        value={value}
        spellCheck={false}
        autoFocus
        onFocus={(event) => {
          // A file's name is chosen up to its extension, as a file manager does.
          const dot = row.folder ? -1 : initial.lastIndexOf('.')
          event.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length)
        }}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            if (shown === null) finish(value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(null)
          }
        }}
        onBlur={() => finish(shown === null ? value : null)}
      />
      {shown && <Problem>{shown}</Problem>}
    </div>
  )
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <span role="alert" className="kp-node__problem">
      {children}
    </span>
  )
}

/** What follows the pointer while rows are dragged: the row's icon and name, or how many. */
function DragChip({
  paths,
  isFolder,
}: {
  paths: readonly string[]
  isFolder: (path: string) => boolean
}) {
  const { t } = useTranslation('files')
  const first = paths[0]
  if (!first) return null
  return (
    <div className="flex h-7 max-w-60 items-center gap-2 rounded-lg bg-surface py-1 pr-2.5 pl-2 text-ui text-primary shadow-menu">
      <FileTypeIcon path={first} folder={isFolder(first)} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">
        {paths.length === 1 ? nameOf(first) : t('tree.items', { count: paths.length })}
      </span>
    </div>
  )
}
