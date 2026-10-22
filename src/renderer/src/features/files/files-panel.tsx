import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronRightIcon,
  ListIcon,
  ListTreeIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import type { FileSearch } from '@shared/files'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { errorMessage, host } from '@renderer/lib/host'
import { isMac } from '@renderer/lib/platform'
import { layoutStorage } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import { loadFiles, openFile, refreshFiles, useFilesStore } from '@renderer/stores/files'
import { toggleSidePane, useViewStore } from '@renderer/stores/view'
import { FilePreview } from './file-preview'
import { FileTypeIcon } from './file-type-icon'
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

/** The side panel's Files pane: the project's files beside the one that is open. */
export default function FilesPanel({
  projectPath,
  maximized,
}: {
  projectPath: string
  maximized: boolean
}) {
  const { t } = useTranslation(['files', 'common'])
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized
  const open = useFilesStore((s) => s.open[projectPath] ?? null)
  const [query, setQuery] = useState('')
  const [flat, setFlat] = useState(false)
  const layout = useDefaultLayout({ id: 'files-pane', storage: layoutStorage })
  // The list folds away to read a file undisturbed; the saved layout keeps it folded.
  const list = usePanelRef()
  const [listHidden, setListHidden] = useState(false)

  useEffect(() => {
    void loadFiles(projectPath)
    const onFocus = () => refreshFiles(projectPath)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectPath])

  return (
    <div
      className={cn(
        'flex h-full min-h-0 animate-in flex-col bg-sidebar fade-in animation-duration-(--duration-fast)',
        maximized && 'absolute inset-0 z-10',
      )}
    >
      {/* A window drag region, as the terminal's header; its controls opt out. */}
      <div
        className={cn(
          'app-region-drag flex h-top-bar shrink-0 items-center gap-1 pr-2 pl-2',
          cornered && (isMac ? 'pl-[84px]' : 'pl-2'),
          !isMac && 'pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+8px)]',
        )}
      >
        {cornered && <SidebarToggle className="mr-1" />}
        <PanelButton
          label={listHidden ? t('panel.showFiles') : t('panel.hideFiles')}
          onClick={() => (listHidden ? list.current?.expand() : list.current?.collapse())}
        >
          {listHidden ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
        </PanelButton>
        {!listHidden && (
          <InputGroup className="app-region-no-drag h-7 max-w-80 min-w-0 flex-1 bg-background/60">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && query && setQuery('')}
              placeholder={t('panel.filterPlaceholder')}
              aria-label={t('panel.filterLabel')}
              spellCheck={false}
              className="text-ui"
            />
          </InputGroup>
        )}
        <span className="flex-1" />
        {!listHidden && (
          <PanelButton
            label={flat ? t('panel.showTree') : t('panel.showList')}
            onClick={() => setFlat(!flat)}
          >
            {flat ? <ListTreeIcon /> : <ListIcon />}
          </PanelButton>
        )}
        <PanelButton
          label={maximized ? t('panel.restore') : t('panel.maximize')}
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </PanelButton>
        <PanelButton
          label={t('common:actions.close')}
          onClick={() => toggleSidePane(projectPath, 'files', false)}
        >
          <XIcon />
        </PanelButton>
      </div>
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="files-tree"
          panelRef={list}
          defaultSize="220px"
          minSize="160px"
          collapsible
          collapsedSize="0px"
          onResize={(size) => setListHidden(size.inPixels === 0)}
          className="min-w-0"
        >
          <Browser projectPath={projectPath} query={query} flat={flat} openPath={open?.path} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="files-preview" minSize="200px" className="min-w-0">
          <FilePreview projectPath={projectPath} file={open} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

/** The tree, the full list, the filter's matches or the search's lines, by what is typed. */
function Browser({
  projectPath,
  query,
  flat,
  openPath,
}: {
  projectPath: string
  query: string
  flat: boolean
  openPath: string | undefined
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
      />
    )
  }
  if (files.paths.length === 0) return <Message>{t('browser.empty')}</Message>
  return flat ? (
    <FlatList projectPath={projectPath} paths={files.paths} openPath={openPath} />
  ) : (
    <Tree projectPath={projectPath} paths={files.paths} openPath={openPath} />
  )
}

function Tree({
  projectPath,
  paths,
  openPath,
}: {
  projectPath: string
  paths: string[]
  openPath: string | undefined
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
      className="h-full py-1"
    >
      {(i) => {
        const row = rows[i]!
        const isOpen = expanded.has(row.path)
        return (
          <Row
            key={row.path}
            depth={row.depth}
            selected={row.path === openPath}
            title={row.path}
            aria-expanded={row.folder ? isOpen : undefined}
            onClick={() => (row.folder ? toggle(row.path) : openFile(projectPath, row.path))}
          >
            {row.folder ? (
              <>
                <ChevronRightIcon
                  className={cn(
                    'size-3 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
                    isOpen && 'rotate-90',
                  )}
                />
                <FileTypeIcon path={row.path} folder open={isOpen} className="size-4" />
              </>
            ) : (
              <FileTypeIcon path={row.path} className="ml-4 size-4" />
            )}
            <span className="truncate">{nameOf(row.path)}</span>
          </Row>
        )
      }}
    </VirtualRows>
  )
}

function FlatList({
  projectPath,
  paths,
  openPath,
}: {
  projectPath: string
  paths: string[]
  openPath: string | undefined
}) {
  const openIndex = openPath ? paths.indexOf(openPath) : -1
  return (
    <VirtualRows
      count={paths.length}
      scrollTo={openIndex < 0 ? null : openIndex}
      className="h-full py-1"
    >
      {(i) => (
        <FileRow
          key={paths[i]}
          projectPath={projectPath}
          match={{ path: paths[i]!, score: 0, positions: [] }}
          selected={paths[i] === openPath}
        />
      )}
    </VirtualRows>
  )
}

function FilteredList({
  projectPath,
  paths,
  query,
  openPath,
}: {
  projectPath: string
  paths: string[]
  query: string
  openPath: string | undefined
}) {
  const { t } = useTranslation('files')
  const { matches, total } = useMemo(() => filterPaths(query, paths, FILTER_LIMIT), [query, paths])
  if (total === 0) return <Message>{t('browser.noMatch', { query: query.trim() })}</Message>
  const more = total - matches.length
  return (
    <div className="flex h-full min-h-0 flex-col">
      <VirtualRows count={matches.length} className="flex-1 py-1">
        {(i) => (
          <FileRow
            key={matches[i]!.path}
            projectPath={projectPath}
            match={matches[i]!}
            selected={matches[i]!.path === openPath}
          />
        )}
      </VirtualRows>
      {more > 0 && (
        <p className="shrink-0 border-t border-border-soft px-3 py-1.5 text-xs text-muted-foreground">
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
}: {
  projectPath: string
  match: PathMatch
  selected: boolean
}) {
  const { path, positions } = match
  const nameStart = path.lastIndexOf('/') + 1
  const marked = new Set(positions)
  const folder = folderOf(path)
  return (
    <Row selected={selected} title={path} onClick={() => openFile(projectPath, path)}>
      <FileTypeIcon path={path} className="size-4" />
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0">
          {[...path.slice(nameStart)].map((char, i) =>
            marked.has(nameStart + i) ? (
              <mark key={i} className="bg-transparent font-semibold text-foreground">
                {char}
              </mark>
            ) : (
              char
            ),
          )}
        </span>
        {folder && <span className="truncate text-xs text-muted-foreground">{folder}</span>}
      </span>
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
      <VirtualRows count={rows.length} className="flex-1 py-1">
        {(i) => {
          const row = rows[i]!
          if (row.kind === 'file') {
            return (
              <div
                key={`f:${row.path}`}
                title={row.path}
                className="flex h-row items-center gap-1.5 truncate px-3 text-xs font-medium"
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
              <span className="w-8 shrink-0 text-right font-mono text-[11.5px] text-muted-foreground tabular">
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
        <p className="shrink-0 border-t border-border-soft px-3 py-1.5 text-xs text-muted-foreground">
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
      <mark className="rounded-xs bg-attention/25 text-foreground">
        {text.slice(at, at + query.length)}
      </mark>
      {text.slice(at + query.length)}
    </>
  )
}

function Row({
  depth = 0,
  selected = false,
  title,
  onClick,
  children,
  ...aria
}: {
  depth?: number
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
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        'flex h-row w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        selected
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'hover:bg-sidebar-accent/70',
      )}
    >
      {children}
    </button>
  )
}

function Message({ tone, children }: { tone?: 'error'; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-center gap-2 px-3 py-3 text-xs leading-normal',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  )
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2.5 px-3 py-3">
      {[60, 45, 70, 50, 35].map((w) => (
        <Skeleton key={w} className="h-3" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}
