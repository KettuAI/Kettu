import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  CodeIcon,
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  MinusSignSquareIcon,
  MoreHorizontalIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { FileSearch } from '@shared/files'
import type { ChangeStatus } from '@shared/git'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { LineCounts } from '@renderer/features/git/rows'
import { MENTION_LIMIT } from '@renderer/features/session/composer/mentions'
import {
  PaneBody,
  PaneContext,
  PaneEmpty,
  PaneIcon,
  PaneSpinner,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { diffId, openDiff, openFile, useFilesStore, watchFiles } from '@renderer/stores/files'
import { useViewStore } from '@renderer/stores/view'
import { openGitPane } from '@renderer/features/git/pane/open-pane'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { ChangeBadge } from './change-badge'
import { useFileChanges, type FileChanges, type ProjectChange } from './changes'
import { columnOf, saveColumn } from './column'
import { FileTree, type TreeEdit } from './file-tree'
import { openInEditor } from './open-in-editor'
import { FileTypeIcon } from './file-type-icon'
import { folderOf, nameOf, rankPaths, type PathMatch } from './paths'
import { VirtualRows } from './virtual-rows'

const SEARCH_DELAY_MS = 250
// A single click in a list opens the preview tab, which the next single click replaces, right
// after the Files tab; a double click opens a tab that stays.
const PREVIEW = { preview: true, fromPanel: true }
const KEPT = { fromPanel: true }
// A change's row: its name, its folder under it.
const CHANGE_ROW = 40

interface FilesPanelProps {
  projectPath: string
  /** The side panel it shows in, whose row the files it opens become tabs of. */
  panel: string
}

/**
 * What the Files tab shows in the side panel: the changes or the project's files, each of which
 * opens in a tab of its own. Its context bar switches between Changes and All files, or holds the
 * filter while one is typed.
 */
export default function FilesPanel(props: FilesPanelProps) {
  // Each side panel has its own column, so another session's pane starts from its own.
  return <FilesPane key={`${props.panel}\0${props.projectPath}`} {...props} />
}

function FilesPane({ projectPath, panel }: FilesPanelProps) {
  const { t } = useTranslation(['files', 'common'])
  const columnKey = `${panel}\0${projectPath}`
  // The file the panel showed last, which the lists mark.
  const openPath = useViewStore((s) => fileOfKey(s.sideDoc[panel]))
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  // Editors open folders on this computer only.
  const local = !isWeb && hostOfPath(projectPath) === null
  const [query, setQuery] = useState(() => columnOf(columnKey).query)
  const [searching, setSearching] = useState(() => columnOf(columnKey).searching)
  const changes = useFileChanges(projectPath)
  const changed = changes.list?.length ?? 0
  // The changes first when there are any as the pane opens; after that the column stays where it
  // is, and new changes only count on its Changes tab. A folder without git has only its files.
  const [chosenMode, setMode] = useState(() => columnOf(columnKey).mode)
  const opening = changed > 0 ? 'changes' : 'all'
  if (chosenMode === null && isRepo && (changes.list !== null || changes.error !== null)) {
    setMode(opening)
  }
  const mode = !isRepo || searching ? 'all' : (chosenMode ?? opening)
  // A name typed in the tree for a new file or folder or a rename, and Collapse all's count.
  const [edit, setEdit] = useState<TreeEdit | null>(null)
  const [collapsed, setCollapsed] = useState(0)
  // A folder with no files yet, as a new scratch session's, has nothing to list or open, so the
  // pane says so once, in its middle, instead of in each half, until a file is being made.
  const bare =
    useFilesStore((s) => {
      const files = s.byProject[projectPath]
      return !!files && !files.error && files.paths.length === 0 && files.folders.length === 0
    }) && edit === null
  const listed = useFilesStore((s) => !!s.byProject[projectPath] && !s.byProject[projectPath].error)
  // New file and New folder go into the project's folder, in the tree, shown for them.
  const startNew = (type: 'file' | 'folder') => {
    stopSearching()
    setMode('all')
    setEdit({ kind: 'new', folder: '', type })
  }

  // The list follows the files while the pane shows; window focus refreshes it through the git
  // status it brings.
  useEffect(() => watchFiles(projectPath), [projectPath])

  useEffect(() => {
    saveColumn(columnKey, { mode: chosenMode, query, searching })
  }, [columnKey, chosenMode, query, searching])

  const stopSearching = (): void => {
    setQuery('')
    setSearching(false)
  }

  const treeList =
    mode === 'changes' ? (
      <ChangesList projectPath={projectPath} panel={panel} changes={changes} />
    ) : (
      <Browser
        projectPath={projectPath}
        panel={panel}
        columnKey={columnKey}
        query={query}
        openPath={openPath}
        changes={changes.byPath}
        local={local}
        edit={edit}
        onEdit={setEdit}
        collapsed={collapsed}
      />
    )

  return (
    <PaneBody
      data-files-panel={projectPath}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
          event.preventDefault()
          setSearching(true)
        }
      }}
    >
      <PaneContext
        tools={
          <>
            {listed && (mode === 'all' || bare) && (
              <>
                <PanelButton label={t('tree.newFile')} onClick={() => startNew('file')}>
                  <PaneIcon icon={FileAddIcon} />
                </PanelButton>
                <PanelButton label={t('tree.newFolder')} onClick={() => startNew('folder')}>
                  <PaneIcon icon={FolderAddIcon} />
                </PanelButton>
                {!bare && !searching && (
                  <PanelButton
                    label={t('tree.collapseAll')}
                    onClick={() => setCollapsed((count) => count + 1)}
                  >
                    <PaneIcon icon={MinusSignSquareIcon} />
                  </PanelButton>
                )}
              </>
            )}
            {(!bare || local) && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            aria-label={t('panel.more')}
                            className="kp-tool app-region-no-drag"
                          />
                        }
                      />
                    }
                  >
                    <PaneIcon icon={MoreHorizontalIcon} />
                  </TooltipTrigger>
                  <TooltipContent>{t('panel.more')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="w-56">
                  {!bare && (
                    <DropdownMenuItem
                      onClick={() => (searching ? stopSearching() : setSearching(true))}
                    >
                      <PaneIcon icon={Search01Icon} size={16} />
                      {t('panel.findFile')}
                      <DropdownMenuShortcut>{formatShortcut('Mod+P')}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )}
                  {local && (
                    <DropdownMenuItem
                      onClick={() =>
                        void openInEditor(projectPath).catch((failure: unknown) =>
                          toast(errorMessage(failure)),
                        )
                      }
                    >
                      <PaneIcon icon={CodeIcon} size={16} />
                      {t('panel.openInEditor')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      >
        {searching ? (
          <label className="kp-find">
            <PaneIcon icon={Search01Icon} size={14} />
            <input
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && stopSearching()}
              onBlur={() => query === '' && setSearching(false)}
              placeholder={t('panel.filterPlaceholder')}
              aria-label={t('panel.filterLabel')}
              spellCheck={false}
            />
            <kbd>esc</kbd>
          </label>
        ) : isRepo ? (
          <SegmentedControl
            aria-label={t('panel.show')}
            variant="tray"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'changes',
                label: t('panel.changes'),
                ...(changed > 0 && { count: changed }),
              },
              { value: 'all', label: t('panel.allFiles') },
            ]}
          />
        ) : (
          <span className="kp-ctx__place">
            <b>{t('panel.title')}</b>
          </span>
        )}
      </PaneContext>
      <div className="kp-body">
        {bare ? (
          <PaneEmpty
            icon={<PaneIcon icon={Folder01Icon} size={20} />}
            title={t('panel.emptyTitle')}
            text={t('panel.emptyDescription')}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{treeList}</div>
        )}
        {mode === 'changes' && !bare && (
          <ChangesFoot projectPath={projectPath} panel={panel} changes={changes} />
        )}
      </div>
    </PaneBody>
  )
}

/** The file a tab's key names, when it is a file's. */
const fileOfKey = (key: string | undefined): string | undefined =>
  key?.startsWith('file:') ? key.slice('file:'.length) : undefined

/** The listed change the panel's tab shows or showed last: its diff, or the file itself. */
function useShownChange(panel: string, list: ProjectChange[] | null): ProjectChange | undefined {
  const key = useViewStore((s) => s.sideDoc[panel])
  return list?.find(
    (change) =>
      key === `diff:${diffId({ path: change.file.path, ref: null })}` ||
      key === `file:${change.path}`,
  )
}

/** Opens the working tree's change to a listed file in a diff tab. */
function showChange(projectPath: string, change: ProjectChange, kept: boolean): void {
  openDiff(
    projectPath,
    {
      path: change.file.path,
      oldPath: change.file.oldPath,
      ref: null,
      projectFile: change.file.status === 'deleted' ? null : change.path,
    },
    kept ? KEPT : PREVIEW,
  )
}

/** The uncommitted changes, one row each: the file's name with its folder under it. */
function ChangesList({
  projectPath,
  panel,
  changes,
}: {
  projectPath: string
  panel: string
  changes: FileChanges
}) {
  const { t } = useTranslation('files')
  const list = changes.list
  const shown = useShownChange(panel, list)

  if (!list) {
    return changes.error ? <Message tone="error">{changes.error}</Message> : <LoadingRows />
  }
  if (list.length === 0) {
    return <PaneEmpty title={t('changes.emptyTitle')} text={t('changes.emptyDescription')} />
  }
  return (
    <VirtualRows count={list.length} rowHeight={CHANGE_ROW} className="kp-tree" roving>
      {(i, tabIndex) => {
        const change = list[i]!
        return (
          <ChangeRow
            key={change.path}
            change={change}
            selected={change === shown}
            tabIndex={tabIndex}
            onOpen={() => showChange(projectPath, change, false)}
            onKeep={() => showChange(projectPath, change, true)}
          />
        )
      }}
    </VirtualRows>
  )
}

function ChangeRow({
  change,
  selected,
  tabIndex,
  onOpen,
  onKeep,
}: {
  change: ProjectChange
  selected: boolean
  tabIndex: number | undefined
  onOpen: () => void
  onKeep: () => void
}) {
  const folder = folderOf(change.path)
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      className="kp-node kp-node--change"
      aria-current={selected || undefined}
      title={change.file.oldPath ? `${change.file.oldPath} → ${change.path}` : change.path}
      onClick={onOpen}
      onDoubleClick={onKeep}
    >
      <FileTypeIcon path={change.path} className="size-4" />
      <span className="kp-node__name">
        <span>{nameOf(change.path)}</span>
        {folder && <small>{folder}</small>}
      </span>
      <ChangeBadge status={change.file.status} />
    </button>
  )
}

/** Under the changes: how many and how large, with Discard for the shown one and Commit… */
function ChangesFoot({
  projectPath,
  panel,
  changes,
}: {
  projectPath: string
  panel: string
  changes: FileChanges
}) {
  const { t } = useTranslation('files')
  const selected = useShownChange(panel, changes.list)
  const totals = useGitStore((s) => s.status[projectPath]?.changes ?? null)
  const blocked = useGitStore(
    (s) =>
      !!s.status[projectPath]?.operation || (s.status[projectPath]?.changes.conflicted ?? 0) > 0,
  )
  const list = changes.list
  if (!list || list.length === 0) return null
  return (
    <div className="kp-files__foot">
      <span className="inline-flex items-center gap-1.5 tabular">
        {t('changes.files', { count: list.length })}
        {totals && (
          <>
            <span aria-hidden>·</span>
            <LineCounts insertions={totals.insertions} deletions={totals.deletions} />
          </>
        )}
      </span>
      <span className="kp-files__acts">
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <button
              type="button"
              className="kp-btn kp-btn--sm"
              disabled={!selected || selected.file.status === 'conflicted' || blocked}
              onClick={() =>
                selected &&
                openGitDialog(projectPath, { kind: 'discard', paths: [selected.file.path] })
              }
            >
              {t('changes.discard')}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {selected
              ? t('changes.discardFile', { name: nameOf(selected.path) })
              : t('changes.discardPick')}
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          className="kp-btn kp-btn--sm kp-btn--solid"
          disabled={blocked}
          onClick={() =>
            openGitPane(projectPath, {
              tab: 'changes',
              commit: { only: list.map((c) => c.file.path), andPush: false },
            })
          }
        >
          {t('changes.commit')}
        </button>
      </span>
    </div>
  )
}

/** The tree, the filter's matches or the search's lines, by what is typed. */
function Browser({
  projectPath,
  panel,
  columnKey,
  query,
  openPath,
  changes,
  local,
  edit,
  onEdit,
  collapsed,
}: {
  projectPath: string
  panel: string
  columnKey: string
  query: string
  openPath: string | undefined
  changes: ReadonlyMap<string, ChangeStatus>
  local: boolean
  edit: TreeEdit | null
  onEdit: (edit: TreeEdit | null) => void
  collapsed: number
}) {
  const files = useFilesStore((s) => s.byProject[projectPath])
  if (!files) return <LoadingRows />
  if (files.error && files.paths.length === 0) {
    return <Message tone="error">{files.error}</Message>
  }
  if (query.startsWith('?')) {
    return <SearchResults projectPath={projectPath} query={query.slice(1).trim()} />
  }
  if (query.trim()) {
    return (
      <FilteredList
        projectPath={projectPath}
        paths={files.paths}
        query={query}
        openPath={openPath}
        changes={changes}
      />
    )
  }
  return (
    <FileTree
      projectPath={projectPath}
      panel={panel}
      columnKey={columnKey}
      files={files}
      openPath={openPath}
      changes={changes}
      local={local}
      edit={edit}
      onEdit={onEdit}
      collapsed={collapsed}
    />
  )
}

function FilteredList({
  projectPath,
  paths,
  query,
  openPath,
  changes,
}: {
  projectPath: string
  paths: string[]
  query: string
  openPath: string | undefined
  changes: ReadonlyMap<string, ChangeStatus>
}) {
  const { t } = useTranslation('files')
  // As in the composer's mentions: the best few by the same matcher, trailing the typing on a
  // long list rather than holding it up.
  const typed = useDeferredValue(query)
  const { matches, total } = useMemo(() => rankPaths(typed, paths, MENTION_LIMIT), [typed, paths])
  if (total === 0) return <Message>{t('browser.noMatch', { query: typed.trim() })}</Message>
  const more = total - matches.length
  return (
    <div className="kp-tree">
      <VirtualRows count={matches.length} className="flex-1" roving>
        {(i, tabIndex) => (
          <FileRow
            key={matches[i]!.path}
            projectPath={projectPath}
            match={matches[i]!}
            selected={matches[i]!.path === openPath}
            change={changes.get(matches[i]!.path)}
            tabIndex={tabIndex}
          />
        )}
      </VirtualRows>
      {more > 0 && <p className="kp-tree__more">{t('browser.moreMatches', { count: more })}</p>}
    </div>
  )
}

/** A file in a list: its name with the matched characters marked, then its folder. */
function FileRow({
  projectPath,
  match,
  selected,
  change,
  tabIndex,
}: {
  projectPath: string
  match: PathMatch
  selected: boolean
  change: ChangeStatus | undefined
  tabIndex: number | undefined
}) {
  const { path, positions } = match
  const nameStart = path.lastIndexOf('/') + 1
  const marked = new Set(positions)
  const folder = folderOf(path)
  return (
    <Row
      selected={selected}
      title={path}
      tabIndex={tabIndex}
      onClick={() => openFile(projectPath, path, null, PREVIEW)}
      onDoubleClick={() => openFile(projectPath, path, null, KEPT)}
    >
      <FileTypeIcon path={path} className="size-4" />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="max-w-full shrink-0 truncate text-primary">
          {[...path.slice(nameStart)].map((char, i) =>
            marked.has(nameStart + i) ? <mark key={i}>{char}</mark> : char,
          )}
        </span>
        {/* The folder gives way first, so a narrow tree still shows the name. */}
        {folder && <span className="min-w-0 truncate text-caption text-disabled">{folder}</span>}
      </span>
      {change && <ChangeBadge status={change} />}
    </Row>
  )
}

type SearchState =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'done'; query: string; result: FileSearch }
  | { status: 'failed'; query: string; error: string }

function SearchResults({ projectPath, query }: { projectPath: string; query: string }) {
  const { t } = useTranslation('files')
  const [state, setState] = useState<SearchState>({ status: 'idle' })

  useEffect(() => {
    if (!query) return
    let current = true
    const timer = setTimeout(() => {
      setState({ status: 'searching', query })
      host('files.search', { projectPath, query })
        .then((result) => current && setState({ status: 'done', query, result }))
        .catch((error: unknown) => {
          if (current) setState({ status: 'failed', query, error: errorMessage(error) })
        })
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [projectPath, query])

  const rows = useMemo(() => {
    if (state.status !== 'done') return []
    const out: (
      { kind: 'file'; path: string } | { kind: 'line'; path: string; line: number; text: string }
    )[] = []
    let last = ''
    for (const match of state.result.matches) {
      if (match.path !== last) out.push({ kind: 'file', path: match.path })
      last = match.path
      out.push({ kind: 'line', ...match })
    }
    return out
  }, [state])

  if (!query) return <Message>{t('browser.searchHint')}</Message>
  if (state.status === 'failed') return <Message tone="error">{state.error}</Message>
  if (state.status !== 'done' || state.query !== query) {
    return (
      <Message>
        <PaneSpinner />
        {t('browser.searching')}
      </Message>
    )
  }
  if (rows.length === 0) return <Message>{t('browser.noLine', { query })}</Message>
  return (
    <div className="kp-tree">
      <VirtualRows count={rows.length} className="flex-1">
        {(i) => {
          const row = rows[i]!
          if (row.kind === 'file') {
            return (
              <div key={`f:${row.path}`} title={row.path} className="kp-node__group">
                <FileTypeIcon path={row.path} className="size-4" />
                <span className="truncate">{row.path}</span>
              </div>
            )
          }
          return (
            <Row
              key={`l:${row.path}:${row.line}`}
              title={row.text}
              onClick={() => openFile(projectPath, row.path, row.line, PREVIEW)}
              onDoubleClick={() => openFile(projectPath, row.path, row.line, KEPT)}
            >
              <span className="kp-node__line">{row.line}</span>
              <span className="kp-mono truncate text-caption text-secondary">
                <Highlight text={row.text.trim()} query={query} />
              </span>
            </Row>
          )
        }}
      </VirtualRows>
      {state.result.truncated && (
        <p className="kp-tree__more">
          {t('browser.truncated', { count: state.result.matches.length })}
        </p>
      )}
    </div>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-xs bg-mark text-primary">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  )
}

function Row({
  depth = 0,
  folder = false,
  selected = false,
  title,
  tabIndex,
  treeItem = false,
  onClick,
  onDoubleClick,
  children,
  ...aria
}: {
  depth?: number
  /** A folder's row leads with its chevron; a file's keeps the chevron's room. */
  folder?: boolean
  selected?: boolean
  title: string
  /** Its list's Tab stop, or -1 for the other rows of a list that is one. */
  tabIndex?: number
  /** A row of the tree, which names its level. */
  treeItem?: boolean
  onClick: () => void
  onDoubleClick?: () => void
  children: ReactNode
  'aria-expanded'?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      tabIndex={tabIndex}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      {...aria}
      {...(treeItem && { role: 'treeitem', 'aria-level': depth + 1, 'aria-selected': selected })}
      style={{ paddingLeft: 8 + depth * 14 }}
      aria-current={selected || undefined}
      className={folder ? 'kp-node kp-node--dir' : 'kp-node'}
    >
      <span className="kp-node__chev">
        {folder && <PaneIcon icon={ArrowRight01Icon} size={12} />}
      </span>
      {children}
    </button>
  )
}

function Message({ tone, children }: { tone?: 'error'; children: ReactNode }) {
  return (
    <p className="kp-tree__note" data-tone={tone}>
      {children}
    </p>
  )
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2.5 px-2 py-3">
      {[60, 45, 70, 50, 35].map((w) => (
        <Skeleton key={w} className="h-3" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}
