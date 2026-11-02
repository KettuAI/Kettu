import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronRightIcon,
  FolderIcon,
  Maximize2Icon,
  Minimize2Icon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDefaultLayout } from 'react-resizable-panels'
import type { FileSearch } from '@shared/files'
import type { ChangeStatus } from '@shared/git'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { LineCounts } from '@renderer/features/git/rows'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { CornerControls } from '@renderer/features/shell/top-bar'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut, hasBand, isMod } from '@renderer/lib/platform'
import { layoutStorage } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import { loadFiles, openDiff, openFile, refreshFiles, useFilesStore } from '@renderer/stores/files'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { toggleSidePane, useViewStore } from '@renderer/stores/view'
import { ChangeBadge } from './change-badge'
import { useFileChanges, type FileChanges } from './changes'
import { DiffPreview } from './diff-preview'
import { FilePreview } from './file-preview'
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

/** The side panel's Files pane: the changes or the project's files, beside the one that is open. */
export default function FilesPanel({
  projectPath,
  maximized,
}: {
  projectPath: string
  maximized: boolean
}) {
  const { t } = useTranslation(['files', 'common'])
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && !hasBand
  const open = useFilesStore((s) => s.open[projectPath] ?? null)
  const diff = useFilesStore((s) => s.diffs[projectPath] ?? null)
  const isRepo = useGitStore((s) => !!s.status[projectPath]?.repo)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const changes = useFileChanges(projectPath)
  const changed = changes.list?.length ?? 0
  // The changes first while there are any; a folder without git has only its files.
  const [chosenMode, setMode] = useState<'changes' | 'all' | null>(null)
  const mode = !isRepo || searching ? 'all' : (chosenMode ?? (changed > 0 ? 'changes' : 'all'))
  const layout = useDefaultLayout({ id: 'files-pane', storage: layoutStorage })
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

  return (
    <div
      className={cn(
        'flex h-full min-h-0 animate-in flex-col fade-in animation-duration-(--duration-fast)',
        SHEET,
        maximized && 'absolute inset-0 z-10',
      )}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
          event.preventDefault()
          setSearching(true)
        }
      }}
    >
      {/* A window drag region, as the terminal's header; its controls opt out. */}
      <div
        className={cn(
          'app-region-drag flex h-11 shrink-0 items-center gap-1 pr-2 pl-2.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && 'pl-(--corner-inset)',
        )}
      >
        {cornered && <CornerControls className="mr-1" />}
        {searching ? (
          <InputGroup className="app-region-no-drag h-7 w-80 min-w-0">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && stopSearching()}
              onBlur={() => query === '' && setSearching(false)}
              placeholder={t('panel.filterPlaceholder')}
              aria-label={t('panel.filterLabel')}
              spellCheck={false}
              className="text-ui"
            />
          </InputGroup>
        ) : (
          isRepo && (
            <SegmentedControl
              aria-label={t('panel.show')}
              value={mode}
              onChange={setMode}
              className="app-region-no-drag shrink-0"
              itemClassName="h-6 px-2.25 text-hint"
              segments={[
                {
                  value: 'changes',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      {t('panel.changes')}
                      {changed > 0 && (
                        <span className="font-normal text-tertiary tabular">{changed}</span>
                      )}
                    </span>
                  ),
                },
                { value: 'all', label: t('panel.allFiles') },
              ]}
            />
          )
        )}
        <span className="flex-1" />
        {!bare && !searching && (
          <PanelButton
            label={t('panel.findFile')}
            shortcut={formatShortcut('Mod+P')}
            onClick={() => setSearching(true)}
          >
            <SearchIcon className="size-3.5" />
          </PanelButton>
        )}
        <PanelButton
          label={maximized ? t('panel.restore') : t('panel.maximize')}
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          {maximized ? (
            <Minimize2Icon className="size-3.5" />
          ) : (
            <Maximize2Icon className="size-3.5" />
          )}
        </PanelButton>
        <PanelButton
          label={t('panel.close')}
          onClick={() => toggleSidePane(projectPath, 'files', false)}
        >
          <XIcon className="size-3.5" />
        </PanelButton>
      </div>
      {bare ? (
        <Empty className="min-h-0 flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon />
            </EmptyMedia>
            <EmptyTitle>{t('panel.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('panel.emptyDescription')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
          className="min-h-0 flex-1"
        >
          <ResizablePanel
            id="files-tree"
            defaultSize="220px"
            minSize="160px"
            collapsible
            collapsedSize="0px"
            className="min-w-0 shadow-[inset_calc(-1*var(--hairline))_0_0_var(--border-subtle)]"
          >
            {mode === 'changes' ? (
              <ChangesList projectPath={projectPath} changes={changes} />
            ) : (
              <Browser
                projectPath={projectPath}
                query={query}
                openPath={open?.path}
                changes={changes.byPath}
              />
            )}
          </ResizablePanel>
          <ResizableHandle className="bg-transparent" />
          <ResizablePanel id="files-preview" minSize="200px" className="min-w-0">
            {diff ? (
              <DiffPreview projectPath={projectPath} diff={diff} />
            ) : (
              <FilePreview
                projectPath={projectPath}
                file={open}
                change={open ? changes.byPath.get(open.path) : undefined}
                onShowDiff={
                  open && changes.byPath.has(open.path)
                    ? () => showChange(projectPath, changes, open.path)
                    : undefined
                }
              />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      <UnsavedPrompt projectPath={projectPath} />
    </div>
  )
}

/** Opens the working tree's change to a listed file in the preview's place. */
function showChange(projectPath: string, changes: FileChanges, path: string): void {
  const change = changes.list?.find((c) => c.path === path)
  if (!change) return
  openDiff(projectPath, {
    path: change.file.path,
    oldPath: change.file.oldPath,
    ref: null,
    projectFile: change.file.status === 'deleted' ? null : change.path,
  })
}

/** The uncommitted changes as a tree, with their totals, Commit… and Discard under it. */
function ChangesList({ projectPath, changes }: { projectPath: string; changes: FileChanges }) {
  const { t } = useTranslation('files')
  const diff = useFilesStore((s) => s.diffs[projectPath] ?? null)
  const openPath = useFilesStore((s) => s.open[projectPath]?.path ?? null)
  const totals = useGitStore((s) => s.status[projectPath]?.changes ?? null)
  const blocked = useGitStore(
    (s) =>
      !!s.status[projectPath]?.operation || (s.status[projectPath]?.changes.conflicted ?? 0) > 0,
  )
  const list = changes.list
  const index = useMemo(() => indexFolders((list ?? []).map((c) => c.path)), [list])
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(() => {
    const folders = new Set([...index.keys()].filter((path) => path !== '' && !closed.has(path)))
    return treeRows(index, folders)
  }, [index, closed])
  const byPath = useMemo(() => new Map((list ?? []).map((c) => [c.path, c])), [list])
  // The working tree's change shown in the preview, or the open file's when it is one.
  const selectedPath =
    diff && diff.ref === null
      ? ((list ?? []).find((c) => c.file.path === diff.path)?.path ?? null)
      : !diff && openPath && byPath.has(openPath)
        ? openPath
        : null
  const selected = selectedPath ? byPath.get(selectedPath) : undefined

  if (!list) {
    return changes.error ? <Message tone="error">{changes.error}</Message> : <LoadingRows />
  }
  if (list.length === 0) {
    return (
      <Empty className="h-full p-4">
        <EmptyHeader>
          <EmptyTitle className="text-control">{t('changes.emptyTitle')}</EmptyTitle>
          <EmptyDescription className="text-small">
            {t('changes.emptyDescription')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const toggle = (folder: string): void => {
    const next = new Set(closed)
    if (next.has(folder)) next.delete(folder)
    else next.add(folder)
    setClosed(next)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <VirtualRows count={rows.length} className="flex-1 py-2">
        {(i) => {
          const row = rows[i]!
          const change = row.folder ? undefined : byPath.get(row.path)
          const isOpen = row.folder && !closed.has(row.path)
          return (
            <Row
              key={row.path}
              depth={row.depth}
              folder={row.folder}
              open={isOpen}
              selected={row.path === selectedPath}
              title={change?.file.oldPath ? `${change.file.oldPath} → ${row.path}` : row.path}
              aria-expanded={row.folder ? isOpen : undefined}
              onClick={() =>
                row.folder ? toggle(row.path) : showChange(projectPath, changes, row.path)
              }
            >
              <FileTypeIcon path={row.path} folder={row.folder} open={isOpen} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{nameOf(row.path)}</span>
              {change && <ChangeBadge status={change.file.status} />}
            </Row>
          )
        }}
      </VirtualRows>
      <div className="mx-2.5 flex shrink-0 flex-col gap-2 px-0.5 pt-2.5 pb-2.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
        <div className="flex items-center text-small text-tertiary">
          <span className="flex-1 tabular">{t('changes.files', { count: list.length })}</span>
          {totals && <LineCounts insertions={totals.insertions} deletions={totals.deletions} />}
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            className="flex-1"
            disabled={blocked}
            onClick={() =>
              openGitDialog(projectPath, {
                kind: 'commit',
                paths: list.map((c) => c.file.path),
                push: false,
              })
            }
          >
            {t('changes.commit')}
          </Button>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                variant="ghost"
                size="sm"
                disabled={!selected || selected.file.status === 'conflicted' || blocked}
                onClick={() =>
                  selected &&
                  openGitDialog(projectPath, { kind: 'discard', paths: [selected.file.path] })
                }
              >
                {t('changes.discard')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {selected
                ? t('changes.discardFile', { name: nameOf(selected.path) })
                : t('changes.discardPick')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
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
      className="h-full py-2"
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
            open={isOpen}
            selected={row.path === openPath}
            title={row.path}
            aria-expanded={row.folder ? isOpen : undefined}
            onClick={() => (row.folder ? toggle(row.path) : openFile(projectPath, row.path))}
          >
            <FileTypeIcon path={row.path} folder={row.folder} open={isOpen} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{nameOf(row.path)}</span>
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
    <div className="flex h-full min-h-0 flex-col">
      <VirtualRows count={matches.length} className="flex-1 py-2">
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
      {more > 0 && (
        <p className="shrink-0 border-t border-subtle px-3.5 py-1.5 text-xs text-tertiary">
          {t('browser.moreMatches', { count: more })}
        </p>
      )}
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
    <Row selected={selected} title={path} onClick={() => openFile(projectPath, path)}>
      <FileTypeIcon path={path} className="size-4" />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0">
          {[...path.slice(nameStart)].map((char, i) =>
            marked.has(nameStart + i) ? (
              <mark key={i} className="bg-transparent font-semibold text-primary">
                {char}
              </mark>
            ) : (
              char
            ),
          )}
        </span>
        {folder && (
          <span className={cn('truncate text-xs', selected ? 'text-secondary' : 'text-tertiary')}>
            {folder}
          </span>
        )}
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
        <Spinner className="size-3.5" />
        {t('browser.searching')}
      </Message>
    )
  }
  if (rows.length === 0) return <Message>{t('browser.noLine', { query })}</Message>
  return (
    <div className="flex h-full min-h-0 flex-col">
      <VirtualRows count={rows.length} className="flex-1 py-2">
        {(i) => {
          const row = rows[i]!
          if (row.kind === 'file') {
            return (
              <div
                key={`f:${row.path}`}
                title={row.path}
                className="mx-1.5 flex h-7 items-center gap-2 truncate px-2 text-xs font-medium text-primary"
              >
                <FileTypeIcon path={row.path} className="size-4" />
                <span className="truncate">{row.path}</span>
              </div>
            )
          }
          return (
            <Row
              key={`l:${row.path}:${row.line}`}
              depth={1}
              title={row.text}
              onClick={() => openFile(projectPath, row.path, row.line)}
            >
              <span className="w-8 shrink-0 text-right font-mono text-meta text-tertiary tabular">
                {row.line}
              </span>
              <span className="truncate font-mono text-xs">
                <Highlight text={row.text.trim()} query={query} />
              </span>
            </Row>
          )
        }}
      </VirtualRows>
      {state.result.truncated && (
        <p className="shrink-0 border-t border-subtle px-3.5 py-1.5 text-xs text-tertiary">
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
  open = false,
  selected = false,
  title,
  onClick,
  children,
  ...aria
}: {
  depth?: number
  /** A folder's row leads with its chevron; a file's keeps the chevron's room. */
  folder?: boolean
  open?: boolean
  selected?: boolean
  title: string
  onClick: () => void
  children: ReactNode
  'aria-expanded'?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      {...aria}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn(
        'mx-1.5 flex h-7 w-[calc(100%-var(--spacing)*3)] min-w-0 items-center gap-1.5 rounded-lg pr-2 text-left text-ui text-primary outline-none transition-colors duration-(--duration-fast) focus-ring',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      <span className="flex w-2.75 shrink-0 text-tertiary">
        {folder && (
          <ChevronRightIcon
            aria-hidden
            strokeWidth={2}
            className={cn(
              'size-2.75 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        )}
      </span>
      {children}
    </button>
  )
}

function Message({ tone, children }: { tone?: 'error'; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-center gap-2 px-3.5 py-3 text-xs leading-normal',
        tone === 'error' ? 'text-danger' : 'text-secondary',
      )}
    >
      {children}
    </p>
  )
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2.5 px-3.5 py-3">
      {[60, 45, 70, 50, 35].map((w) => (
        <Skeleton key={w} className="h-3" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}
