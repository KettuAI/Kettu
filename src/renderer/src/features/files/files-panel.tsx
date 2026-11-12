import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  CodeIcon,
  Folder01Icon,
  Search01Icon,
  SidebarLeftIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import type { FileSearch } from '@shared/files'
import type { ChangeStatus } from '@shared/git'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { LineCounts } from '@renderer/features/git/rows'
import {
  PaneEmpty,
  PaneHead,
  PaneIcon,
  PaneSheet,
  PaneSpinner,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { layoutStorage } from '@renderer/lib/storage'
import {
  activateTab,
  activeFile,
  closeDiff,
  loadFiles,
  openDiff,
  openFile,
  refreshFiles,
  useFilesStore,
} from '@renderer/stores/files'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { ChangeBadge } from './change-badge'
import { useFileChanges, type FileChanges, type ProjectChange } from './changes'
import { DiffPreview } from './diff-preview'
import { FilePreview } from './file-preview'
import { openInEditor } from './open-in-editor'
import { FileTabs } from './file-tabs'
import { FileTypeIcon } from './file-type-icon'
import { UnsavedPrompt } from './unsaved-prompt'
import {
  filterPaths,
  folderOf,
  foldersAbove,
  indexFolders,
  nameOf,
  treeRows,
  type PathMatch,
} from './paths'
import { VirtualRows } from './virtual-rows'

// A filter that matches more than this shows the best ones; refining it finds the rest.
const FILTER_LIMIT = 1000
const SEARCH_DELAY_MS = 250
// A single click in a list opens the preview tab, which the next single click replaces.
const PREVIEW = { preview: true }
// A change's row: its name, its folder under it.
const CHANGE_ROW = 40

/**
 * The side panel's Files pane: the changes or the project's files, beside the open files. Its head
 * switches between Changes and All files, or holds the filter while one is typed.
 */
export default function FilesPanel({
  projectPath,
  panel,
  maximized,
}: {
  projectPath: string
  /** The side panel it shows in; the open files are the project's, whichever panel shows them. */
  panel: string
  maximized: boolean
}) {
  const { t } = useTranslation(['files', 'common'])
  const tabs = useFilesStore((s) => s.open[projectPath] ?? null)
  const open = activeFile(tabs)
  const diff = useFilesStore((s) => s.diffs[projectPath] ?? null)
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  // Editors open folders on this computer only.
  const local = !isWeb && hostOfPath(projectPath) === null
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const changes = useFileChanges(projectPath)
  const changed = changes.list?.length ?? 0
  // The changes first while there are any; a folder without git has only its files.
  const [chosenMode, setMode] = useState<'changes' | 'all' | null>(null)
  const mode = !isRepo || searching ? 'all' : (chosenMode ?? (changed > 0 ? 'changes' : 'all'))
  const layout = useDefaultLayout({ id: 'files-pane', storage: layoutStorage })
  const tree = usePanelRef()
  const [treeShown, setTreeShown] = useState(true)
  // A folder with no files yet, as a new scratch session's, has nothing to list or open, so the
  // pane says so once, in its middle, instead of in each half.
  const bare = useFilesStore((s) => {
    const files = s.byProject[projectPath]
    return (
      !!files &&
      !files.error &&
      files.paths.length === 0 &&
      !s.open[projectPath] &&
      !s.diffs[projectPath]
    )
  })

  useEffect(() => {
    void loadFiles(projectPath)
    const onFocus = () => refreshFiles(projectPath)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectPath])

  const stopSearching = (): void => {
    setQuery('')
    setSearching(false)
  }

  // The tab the open files show: the active one, unless a change from elsewhere covers them.
  const shownTab =
    !diff || (diff.ref === null && diff.projectFile === open?.path) ? (open?.path ?? null) : null

  return (
    <PaneSheet
      pane="files"
      maximized={maximized}
      data-files-panel={projectPath}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
          event.preventDefault()
          setSearching(true)
        }
      }}
    >
      <PaneHead
        panel={panel}
        pane="files"
        maximized={maximized}
        tools={
          <>
            {!bare && (
              <PanelButton
                label={t('panel.findFile')}
                shortcut={formatShortcut('Mod+P')}
                pressed={searching}
                onClick={() => (searching ? stopSearching() : setSearching(true))}
              >
                <PaneIcon icon={Search01Icon} />
              </PanelButton>
            )}
            {local && (
              <PanelButton
                label={t('panel.openInEditor')}
                onClick={() =>
                  void openInEditor(projectPath).catch((failure: unknown) =>
                    toast(errorMessage(failure)),
                  )
                }
              >
                <PaneIcon icon={CodeIcon} />
              </PanelButton>
            )}
          </>
        }
      >
        {!bare && (
          <PanelButton
            label={treeShown ? t('panel.hideTree') : t('panel.showTree')}
            pressed={treeShown}
            onClick={() =>
              tree.current?.isCollapsed() ? tree.current.expand() : tree.current?.collapse()
            }
          >
            <PaneIcon icon={SidebarLeftIcon} />
          </PanelButton>
        )}
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
            size="md"
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
          <span className="kp-head__title">{t('panel.title')}</span>
        )}
      </PaneHead>
      <div className="kp-body">
        {bare ? (
          <PaneEmpty
            icon={<PaneIcon icon={Folder01Icon} size={20} />}
            title={t('panel.emptyTitle')}
            text={t('panel.emptyDescription')}
          />
        ) : (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              id="files-tree"
              panelRef={tree}
              defaultSize="30%"
              minSize="132px"
              collapsible
              collapsedSize="0px"
              onResize={(size) => setTreeShown(size.inPixels > 0)}
              className="min-w-0"
            >
              {mode === 'changes' ? (
                <ChangesList projectPath={projectPath} changes={changes} openPath={open?.path} />
              ) : (
                <Browser
                  projectPath={projectPath}
                  query={query}
                  openPath={open?.path}
                  changes={changes.byPath}
                />
              )}
            </ResizablePanel>
            <ResizableHandle className="kp-resizer kp-files-handle" />
            <ResizablePanel id="files-preview" minSize="200px" className="min-w-0">
              <section className="kp-doc" aria-label={t('tabs.label')}>
                {!!tabs?.files.length && (
                  <div className="kp-doc__tabs">
                    <FileTabs
                      projectPath={projectPath}
                      files={tabs.files}
                      active={shownTab}
                      onSelect={(path) => {
                        if (path !== shownTab) closeDiff(projectPath)
                        activateTab(projectPath, path)
                      }}
                    />
                  </div>
                )}
                {diff ? (
                  <DiffPreview projectPath={projectPath} diff={diff} />
                ) : (
                  <FilePreview
                    projectPath={projectPath}
                    file={open}
                    changes={changes.byPath}
                    onShowDiff={
                      open && changes.byPath.has(open.path)
                        ? () => showChange(projectPath, changes, open.path, false)
                        : undefined
                    }
                  />
                )}
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
        {mode === 'changes' && !bare && <ChangesFoot projectPath={projectPath} changes={changes} />}
      </div>
      <UnsavedPrompt projectPath={projectPath} />
    </PaneSheet>
  )
}

/**
 * Opens the working tree's change to a listed file: from the list, in the preview tab with the
 * diff over it; from the File view's toggle, over the tab it already has.
 */
function showChange(
  projectPath: string,
  changes: FileChanges,
  path: string,
  fromList: boolean,
): void {
  const change = changes.list?.find((c) => c.path === path)
  if (!change) return
  const deleted = change.file.status === 'deleted'
  if (fromList && !deleted) openFile(projectPath, change.path, null, PREVIEW)
  openDiff(projectPath, {
    path: change.file.path,
    oldPath: change.file.oldPath,
    ref: null,
    projectFile: deleted ? null : change.path,
  })
}

/** The uncommitted changes, one row each: the file's name with its folder under it. */
function ChangesList({
  projectPath,
  changes,
  openPath,
}: {
  projectPath: string
  changes: FileChanges
  openPath: string | undefined
}) {
  const { t } = useTranslation('files')
  const diff = useFilesStore((s) => s.diffs[projectPath] ?? null)
  const list = changes.list
  // The working tree's change shown in the preview, or the open file's when it is one.
  const selectedPath =
    diff && diff.ref === null
      ? ((list ?? []).find((c) => c.file.path === diff.path)?.path ?? null)
      : !diff && openPath
        ? openPath
        : null

  if (!list) {
    return changes.error ? <Message tone="error">{changes.error}</Message> : <LoadingRows />
  }
  if (list.length === 0) {
    return <PaneEmpty title={t('changes.emptyTitle')} text={t('changes.emptyDescription')} />
  }
  return (
    <VirtualRows count={list.length} rowHeight={CHANGE_ROW} className="kp-tree">
      {(i) => {
        const change = list[i]!
        return (
          <ChangeRow
            key={change.path}
            change={change}
            selected={change.path === selectedPath}
            onOpen={() => showChange(projectPath, changes, change.path, true)}
            onKeep={() => openFile(projectPath, change.path)}
          />
        )
      }}
    </VirtualRows>
  )
}

function ChangeRow({
  change,
  selected,
  onOpen,
  onKeep,
}: {
  change: ProjectChange
  selected: boolean
  onOpen: () => void
  onKeep: () => void
}) {
  const folder = folderOf(change.path)
  return (
    <button
      type="button"
      className="kp-node kp-node--change"
      aria-current={selected || undefined}
      title={change.file.oldPath ? `${change.file.oldPath} → ${change.path}` : change.path}
      onClick={onOpen}
      onDoubleClick={change.file.status === 'deleted' ? undefined : onKeep}
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
function ChangesFoot({ projectPath, changes }: { projectPath: string; changes: FileChanges }) {
  const { t } = useTranslation('files')
  const diff = useFilesStore((s) => s.diffs[projectPath] ?? null)
  const openPath = useFilesStore((s) => s.open[projectPath]?.active ?? null)
  const totals = useGitStore((s) => s.status[projectPath]?.changes ?? null)
  const blocked = useGitStore(
    (s) =>
      !!s.status[projectPath]?.operation || (s.status[projectPath]?.changes.conflicted ?? 0) > 0,
  )
  const list = changes.list
  const byPath = useMemo(() => new Map((list ?? []).map((c) => [c.path, c])), [list])
  if (!list || list.length === 0) return null
  // The working tree's change shown in the preview, or the open file's when it is one.
  const selectedPath =
    diff && diff.ref === null
      ? (list.find((c) => c.file.path === diff.path)?.path ?? null)
      : !diff && openPath && byPath.has(openPath)
        ? openPath
        : null
  const selected = selectedPath ? byPath.get(selectedPath) : undefined
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
            openGitDialog(projectPath, { kind: 'commit', paths: list.map((c) => c.file.path) })
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
  query,
  openPath,
  changes,
}: {
  projectPath: string
  query: string
  openPath: string | undefined
  changes: ReadonlyMap<string, ChangeStatus>
}) {
  const { t } = useTranslation('files')
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
  if (files.paths.length === 0) return <Message>{t('browser.empty')}</Message>
  return (
    <Tree projectPath={projectPath} paths={files.paths} openPath={openPath} changes={changes} />
  )
}

function Tree({
  projectPath,
  paths,
  openPath,
  changes,
}: {
  projectPath: string
  paths: string[]
  openPath: string | undefined
  changes: ReadonlyMap<string, ChangeStatus>
}) {
  const index = useMemo(() => indexFolders(paths), [paths])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  // A file opened from the conversation shows in the tree, its folders opened.
  const [revealed, setRevealed] = useState<string | undefined>(undefined)
  if (openPath !== revealed) {
    setRevealed(openPath)
    if (openPath) setExpanded(new Set([...expanded, ...foldersAbove(openPath)]))
  }
  const rows = useMemo(() => treeRows(index, expanded), [index, expanded])
  const openIndex = openPath ? rows.findIndex((r) => r.path === openPath) : -1

  const toggle = (folder: string) => {
    const next = new Set(expanded)
    if (next.has(folder)) next.delete(folder)
    else next.add(folder)
    setExpanded(next)
  }

  return (
    <VirtualRows
      count={rows.length}
      scrollTo={openIndex < 0 ? null : openIndex}
      className="kp-tree"
    >
      {(i) => {
        const row = rows[i]!
        const isOpen = expanded.has(row.path)
        const change = row.folder ? undefined : changes.get(row.path)
        return (
          <Row
            key={row.path}
            depth={row.depth}
            folder={row.folder}
            selected={row.path === openPath}
            title={row.path}
            aria-expanded={row.folder ? isOpen : undefined}
            onClick={() =>
              row.folder ? toggle(row.path) : openFile(projectPath, row.path, null, PREVIEW)
            }
            onDoubleClick={row.folder ? undefined : () => openFile(projectPath, row.path)}
          >
            <FileTypeIcon path={row.path} folder={row.folder} open={isOpen} className="size-4" />
            <span className="kp-node__name">
              <span>{nameOf(row.path)}</span>
            </span>
            {change && <ChangeBadge status={change} />}
          </Row>
        )
      }}
    </VirtualRows>
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
  const { matches, total } = useMemo(() => filterPaths(query, paths, FILTER_LIMIT), [query, paths])
  if (total === 0) return <Message>{t('browser.noMatch', { query: query.trim() })}</Message>
  const more = total - matches.length
  return (
    <div className="kp-tree">
      <VirtualRows count={matches.length} className="flex-1">
        {(i) => (
          <FileRow
            key={matches[i]!.path}
            projectPath={projectPath}
            match={matches[i]!}
            selected={matches[i]!.path === openPath}
            change={changes.get(matches[i]!.path)}
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
}: {
  projectPath: string
  match: PathMatch
  selected: boolean
  change: ChangeStatus | undefined
}) {
  const { path, positions } = match
  const nameStart = path.lastIndexOf('/') + 1
  const marked = new Set(positions)
  const folder = folderOf(path)
  return (
    <Row
      selected={selected}
      title={path}
      onClick={() => openFile(projectPath, path, null, PREVIEW)}
      onDoubleClick={() => openFile(projectPath, path)}
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
              onDoubleClick={() => openFile(projectPath, row.path, row.line)}
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
  onClick: () => void
  onDoubleClick?: () => void
  children: ReactNode
  'aria-expanded'?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      {...aria}
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
