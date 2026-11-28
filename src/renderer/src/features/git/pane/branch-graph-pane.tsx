import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  GitForkIcon,
  LinkSquare02Icon,
  Tag01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  GIT_GRAPH_DEFAULT_LIMIT,
  type BranchGraphCommit,
  type BranchGraphRef,
  type ChangedFile,
  type GitStatus,
} from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ChangeBadge } from '@renderer/features/files/change-badge'
import { Diff } from '@renderer/features/session/markdown'
import {
  LinkSessionContext,
  sessionLinkProps,
  useLinkSessionId,
} from '@renderer/features/session/open-link'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  PaneBody,
  PaneContext,
  PaneEmpty,
  PaneIcon,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { fullTime, longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { refreshGitProject, useGitStore } from '@renderer/stores/git'
import { panelSession } from '@renderer/stores/view'
import {
  computeBranchGraphLayout,
  laneColorVar,
  type BranchGraphRowLayout,
  type GraphLaneLine,
} from '../branch-graph-layout'
import { CopyButton } from '../copy-button'
import { openChangeDiff } from '../open-change-diff'
import { ErrorRow, LineCounts } from '../rows'
import { useCommit, useCommitFileDiff } from '../use-git-data'
import { prepareInlineDiff, toggleExpandedPath } from './inline-diff-model'

const ROW_HEIGHT = 36
const ROW_MID = ROW_HEIGHT / 2
const LANE_SPACING = 14
const GRAPH_PAD_X = 10
const MAX_INLINE_REFS = 3
const CONTINUATION_HEIGHT = 24
const KEPT = { fromPanel: true }

interface GraphState {
  projectPath: string
  commits: BranchGraphCommit[]
  headOid: string | null
  currentBranch: string | null
  detached: boolean
  hasMore: boolean
  nextSkip: number
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  loadMoreError: string | null
}

function emptyGraphState(projectPath: string): GraphState {
  return {
    projectPath,
    commits: [],
    headOid: null,
    currentBranch: null,
    detached: false,
    hasMore: false,
    nextSkip: 0,
    loaded: false,
    loading: true,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  }
}

function mergeCommits(
  existing: readonly BranchGraphCommit[],
  incoming: readonly BranchGraphCommit[],
): BranchGraphCommit[] {
  if (existing.length === 0) return [...incoming]
  const seen = new Set(existing.map((commit) => commit.oid))
  const next = [...existing]
  for (const commit of incoming) {
    if (!seen.has(commit.oid)) {
      seen.add(commit.oid)
      next.push(commit)
    }
  }
  return next
}

function xOf(col: number): number {
  return GRAPH_PAD_X + col * LANE_SPACING
}

function edgePath(fromCol: number, toCol: number, y1: number, y2: number): string {
  const x1 = xOf(fromCol)
  const x2 = xOf(toCol)
  if (fromCol === toCol) return `M ${x1} ${y1} L ${x2} ${y2}`
  const dy = y2 - y1
  return `M ${x1} ${y1} C ${x1} ${y1 + dy * 0.65}, ${x2} ${y1 + dy * 0.35}, ${x2} ${y2}`
}

/**
 * Dedicated read-only Branch Graph tab: displays commit history, branch forks and merges, current
 * branch and ref badges, on-demand pagination for long histories, and commit + diff details on click.
 */
export default function BranchGraphPane({
  panel,
  projectPath,
}: {
  panel: string
  projectPath: string
}) {
  const { t } = useTranslation('git')
  const sessionId = panelSession(panel)
  const status = useGitStore((s) => s.status[projectPath])
  const now = useNow()
  const [graph, setGraph] = useState<GraphState>(() => emptyGraphState(projectPath))
  const [selectedState, setSelectedState] = useState<{
    projectPath: string
    oid: string | null
  }>(() => ({ projectPath, oid: null }))
  const [reloadTick, setReloadTick] = useState(0)
  const requestSeq = useRef(0)
  const loadingMoreRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  const repo = status?.repo ?? null
  const notRepo = status !== undefined && status.repo === null

  // Keep git status current when opening the graph tab so GitHub links and full diff tabs work.
  useEffect(() => {
    refreshGitProject(projectPath)
  }, [projectPath])

  // Load the first page whenever the project changes or the user triggers a refresh.
  useEffect(() => {
    if (notRepo) return
    const seq = ++requestSeq.current
    loadingMoreRef.current = false
    let live = true

    host('git.graph', { projectPath, limit: GIT_GRAPH_DEFAULT_LIMIT, skip: 0 }).then(
      (page) => {
        if (!live || requestSeq.current !== seq) return
        setGraph({
          projectPath,
          commits: page.commits,
          headOid: page.headOid,
          currentBranch: page.currentBranch,
          detached: page.detached,
          hasMore: page.hasMore,
          nextSkip: page.nextSkip,
          loaded: true,
          loading: false,
          loadingMore: false,
          error: null,
          loadMoreError: null,
        })
      },
      (error: unknown) => {
        if (!live || requestSeq.current !== seq) return
        const message = errorMessage(error)
        setGraph((prev) =>
          prev.projectPath === projectPath
            ? { ...prev, loaded: true, loading: false, loadingMore: false, error: message }
            : {
                ...emptyGraphState(projectPath),
                loaded: true,
                loading: false,
                error: message,
              },
        )
      },
    )

    return () => {
      live = false
    }
  }, [projectPath, notRepo, reloadTick])

  const activeGraph = graph.projectPath === projectPath ? graph : emptyGraphState(projectPath)
  const selectedOid = selectedState.projectPath === projectPath ? selectedState.oid : null

  const selectCommit = useCallback(
    (oid: string | null) => {
      setSelectedState({ projectPath, oid })
    },
    [projectPath],
  )

  const handleRefresh = useCallback(() => {
    loadingMoreRef.current = false
    setGraph((prev) =>
      prev.projectPath === projectPath
        ? { ...prev, loading: true, error: null, loadMoreError: null }
        : emptyGraphState(projectPath),
    )
    setReloadTick((n) => n + 1)
    refreshGitProject(projectPath)
  }, [projectPath])

  const loadMore = useCallback(() => {
    if (
      loadingMoreRef.current ||
      activeGraph.loading ||
      !activeGraph.hasMore ||
      activeGraph.projectPath !== projectPath
    ) {
      return
    }
    const seq = requestSeq.current
    const skip = activeGraph.nextSkip
    loadingMoreRef.current = true
    setGraph((prev) =>
      prev.projectPath === projectPath ? { ...prev, loadingMore: true, loadMoreError: null } : prev,
    )

    host('git.graph', { projectPath, limit: GIT_GRAPH_DEFAULT_LIMIT, skip }).then(
      (page) => {
        if (requestSeq.current !== seq) return
        loadingMoreRef.current = false
        setGraph((prev) => {
          if (prev.projectPath !== projectPath) return prev
          return {
            ...prev,
            commits: mergeCommits(prev.commits, page.commits),
            headOid: page.headOid,
            currentBranch: page.currentBranch,
            detached: page.detached,
            hasMore: page.hasMore,
            nextSkip: page.nextSkip,
            loadingMore: false,
            loadMoreError: null,
          }
        })
      },
      (error: unknown) => {
        if (requestSeq.current !== seq) return
        loadingMoreRef.current = false
        setGraph((prev) =>
          prev.projectPath === projectPath
            ? { ...prev, loadingMore: false, loadMoreError: errorMessage(error) }
            : prev,
        )
      },
    )
  }, [
    activeGraph.hasMore,
    activeGraph.loading,
    activeGraph.nextSkip,
    activeGraph.projectPath,
    projectPath,
  ])

  // Automatically load the next page when the user scrolls near the bottom sentinel.
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = listRef.current
    if (
      !sentinel ||
      !root ||
      !activeGraph.hasMore ||
      activeGraph.loadingMore ||
      activeGraph.loadMoreError
    ) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore()
      },
      { root, rootMargin: '160px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeGraph.hasMore, activeGraph.loadingMore, activeGraph.loadMoreError, loadMore])

  const layout = useMemo(() => computeBranchGraphLayout(activeGraph.commits), [activeGraph.commits])
  const graphWidth = Math.max(24, GRAPH_PAD_X * 2 + Math.max(0, layout.maxLanes - 1) * LANE_SPACING)
  const commitsByOid = useMemo(
    () => new Map(activeGraph.commits.map((commit) => [commit.oid, commit])),
    [activeGraph.commits],
  )
  const rowLayoutByOid = useMemo(
    () => new Map(layout.rows.map((row) => [row.oid, row])),
    [layout.rows],
  )
  const selectedCommit = selectedOid ? (commitsByOid.get(selectedOid) ?? null) : null
  const selectedRowLayout = selectedCommit ? (rowLayoutByOid.get(selectedCommit.oid) ?? null) : null

  const jumpToCommit = useCallback(
    (oid: string) => {
      if (!commitsByOid.has(oid)) return
      selectCommit(oid)
      const rowEl = rowRefs.current.get(oid)
      rowEl?.scrollIntoView?.({ block: 'nearest' })
    },
    [commitsByOid, selectCommit],
  )

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const commits = activeGraph.commits
      if (commits.length === 0) return
      if (event.key === 'Escape' && selectedOid) {
        event.preventDefault()
        selectCommit(null)
        return
      }
      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return
      }
      event.preventDefault()
      const currentIndex = selectedOid
        ? commits.findIndex((commit) => commit.oid === selectedOid)
        : -1
      let nextIndex: number
      if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = commits.length - 1
      else if (event.key === 'ArrowDown') {
        nextIndex = currentIndex < 0 ? 0 : Math.min(commits.length - 1, currentIndex + 1)
      } else {
        nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1
      }
      const next = commits[nextIndex]
      if (!next) return
      selectCommit(next.oid)
      const rowEl = rowRefs.current.get(next.oid)
      rowEl?.focus()
      rowEl?.scrollIntoView?.({ block: 'nearest' })
    },
    [activeGraph.commits, selectCommit, selectedOid],
  )

  const headerBranchLabel = activeGraph.currentBranch
    ? activeGraph.currentBranch
    : activeGraph.detached && activeGraph.headOid
      ? `${t('popover.detached')} · ${activeGraph.headOid.slice(0, 7)}`
      : (status?.head.branch ?? null)

  const countLabel = activeGraph.loaded
    ? activeGraph.hasMore
      ? t('graph.loadedMoreCount', { count: activeGraph.commits.length })
      : t('graph.loadedCount', { count: activeGraph.commits.length })
    : null

  const graphList = (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('graph.listLabel')}
      tabIndex={-1}
      onKeyDown={handleListKeyDown}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
    >
      {activeGraph.error && activeGraph.commits.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-subtle bg-danger-tint px-3 py-1.5 text-small text-danger">
          <span className="min-w-0 truncate" title={activeGraph.error}>
            {activeGraph.error.split('\n')[0]}
          </span>
          <Button variant="quiet" size="xs" onClick={handleRefresh} className="shrink-0">
            {t('pane.changes.retry')}
          </Button>
        </div>
      )}
      <div className="flex flex-col py-1">
        {activeGraph.commits.map((commit, index) => {
          const rowLayout = layout.rows[index]!
          const isSelected = commit.oid === selectedCommit?.oid
          const isHead = commit.oid === activeGraph.headOid
          return (
            <GraphCommitRow
              key={commit.oid}
              commit={commit}
              rowLayout={rowLayout}
              graphWidth={graphWidth}
              selected={isSelected}
              isHead={isHead}
              now={now}
              setRowRef={(el) => {
                if (el) rowRefs.current.set(commit.oid, el)
                else rowRefs.current.delete(commit.oid)
              }}
              onSelect={() => selectCommit(commit.oid)}
            />
          )
        })}
      </div>
      {activeGraph.hasMore && (
        <div
          ref={sentinelRef}
          className="flex items-center gap-2 border-t border-subtle px-2.5 py-2"
        >
          <ContinuationRails lanes={layout.openLanes} width={graphWidth} />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              data-graph-load-more=""
              disabled={activeGraph.loadingMore}
              onClick={loadMore}
              className="gap-1.5"
            >
              {activeGraph.loadingMore && <Spinner className="size-3" />}
              {activeGraph.loadingMore ? t('graph.loadingMore') : t('graph.loadMore')}
            </Button>
            {activeGraph.loadMoreError && (
              <span
                className="min-w-0 truncate text-small text-danger"
                title={activeGraph.loadMoreError}
              >
                {activeGraph.loadMoreError.split('\n')[0]}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <LinkSessionContext value={sessionId}>
      <PaneBody data-git-graph-pane={projectPath}>
        {notRepo ? (
          <div className="kp-body">
            <PaneEmpty
              icon={<PaneIcon icon={GitCompareIcon} size={20} />}
              title={t('pane.notRepoTitle')}
              text={t('pane.notRepoText')}
            />
          </div>
        ) : (
          <>
            <PaneContext
              tools={
                <PanelButton
                  label={t('graph.refresh')}
                  disabled={activeGraph.loading}
                  onClick={handleRefresh}
                >
                  <PaneIcon
                    icon={ArrowReloadHorizontalIcon}
                    size={14}
                    className={cn(activeGraph.loading && 'animate-spin')}
                  />
                </PanelButton>
              }
            >
              {headerBranchLabel ? (
                <span className="inline-flex h-5.5 max-w-52 min-w-0 items-center gap-1 rounded-full bg-(--primary-from) px-2 text-caption font-medium text-(--primary-foreground)">
                  <Glyph
                    icon={activeGraph.detached ? GitCommitIcon : GitBranchIcon}
                    size={12}
                    className="shrink-0"
                  />
                  <span className="min-w-0 truncate">{headerBranchLabel}</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-control font-medium text-primary">
                  <Glyph icon={GitForkIcon} size={14} className="text-tertiary" />
                  <span>{t('graph.title')}</span>
                </span>
              )}
              {countLabel && (
                <span className="shrink-0 text-caption text-tertiary tabular">{countLabel}</span>
              )}
              <span className="ml-1 shrink-0 rounded-full bg-subtle px-1.75 py-0.5 text-caption text-tertiary">
                {t('graph.readOnly')}
              </span>
            </PaneContext>

            {activeGraph.loading && activeGraph.commits.length === 0 ? (
              <GraphLoading />
            ) : activeGraph.error && activeGraph.commits.length === 0 ? (
              <div className="kp-body">
                <PaneEmpty
                  icon={<PaneIcon icon={GitForkIcon} size={20} />}
                  title={t('graph.loadFailed')}
                  text={activeGraph.error.split('\n')[0]}
                >
                  <Button variant="outline" size="xs" onClick={handleRefresh} className="mt-3">
                    {t('pane.changes.retry')}
                  </Button>
                </PaneEmpty>
              </div>
            ) : activeGraph.commits.length === 0 ? (
              <div className="kp-body">
                <PaneEmpty
                  icon={<PaneIcon icon={GitForkIcon} size={20} />}
                  title={t('graph.emptyTitle')}
                  text={t('graph.emptyText')}
                />
              </div>
            ) : selectedCommit ? (
              <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
                <ResizablePanel id="branch-graph-list" defaultSize="52%" minSize="25%">
                  <div className="flex h-full min-h-0 flex-col">{graphList}</div>
                </ResizablePanel>
                <ResizableHandle className="h-(--hairline) bg-border-subtle" />
                <ResizablePanel id="branch-graph-detail" defaultSize="48%" minSize="25%">
                  <CommitInspector
                    key={selectedCommit.oid}
                    projectPath={projectPath}
                    status={repo ? status : undefined}
                    commit={selectedCommit}
                    laneColor={
                      selectedRowLayout ? laneColorVar(selectedRowLayout.color) : laneColorVar(0)
                    }
                    loadedOids={commitsByOid}
                    onSelectParent={jumpToCommit}
                    onClose={() => selectCommit(null)}
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              graphList
            )}
          </>
        )}
      </PaneBody>
    </LinkSessionContext>
  )
}

function GraphCommitRow({
  commit,
  rowLayout,
  graphWidth,
  selected,
  isHead,
  now,
  setRowRef,
  onSelect,
}: {
  commit: BranchGraphCommit
  rowLayout: BranchGraphRowLayout
  graphWidth: number
  selected: boolean
  isHead: boolean
  now: number
  setRowRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
}) {
  const { t } = useTranslation('git')
  const visibleRefs = commit.refs.slice(0, MAX_INLINE_REFS)
  const extraRefs = commit.refs.slice(MAX_INLINE_REFS)
  const nodeX = xOf(rowLayout.col)
  const nodeColor = laneColorVar(rowLayout.color)

  return (
    <button
      ref={setRowRef}
      type="button"
      role="option"
      aria-selected={selected}
      data-graph-commit={commit.oid}
      data-selected={selected || undefined}
      onClick={onSelect}
      className={cn(
        'group flex h-9 w-full min-w-0 items-center gap-2 pr-3 pl-2.5 text-left outline-none transition-colors duration-(--duration-fast) focus-visible:focus-ring',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      <svg
        aria-hidden
        width={graphWidth}
        height={ROW_HEIGHT}
        viewBox={`0 0 ${graphWidth} ${ROW_HEIGHT}`}
        className="shrink-0 overflow-visible"
      >
        {rowLayout.passThrough.map((rail) => (
          <line
            key={`pass-${rail.col}`}
            x1={xOf(rail.col)}
            y1={0}
            x2={xOf(rail.col)}
            y2={ROW_HEIGHT}
            stroke={laneColorVar(rail.color)}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        ))}
        {rowLayout.inEdges.map((edge, idx) => (
          <path
            key={`in-${idx}-${edge.fromCol}-${edge.toCol}`}
            d={edgePath(edge.fromCol, edge.toCol, 0, ROW_MID)}
            fill="none"
            stroke={laneColorVar(edge.color)}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        ))}
        {rowLayout.outEdges.map((edge, idx) => (
          <path
            key={`out-${idx}-${edge.fromCol}-${edge.toCol}`}
            d={edgePath(edge.fromCol, edge.toCol, ROW_MID, ROW_HEIGHT)}
            fill="none"
            stroke={laneColorVar(edge.color)}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        ))}
        {isHead && (
          <circle
            cx={nodeX}
            cy={ROW_MID}
            r={6.5}
            fill="none"
            stroke={nodeColor}
            strokeWidth={1.5}
            strokeOpacity={0.45}
          />
        )}
        <circle
          cx={nodeX}
          cy={ROW_MID}
          r={rowLayout.isMerge ? 4.25 : 3.75}
          fill={rowLayout.isMerge ? 'var(--bg-app)' : nodeColor}
          stroke={rowLayout.isMerge ? nodeColor : 'var(--bg-app)'}
          strokeWidth={rowLayout.isMerge ? 2 : 1.75}
        />
      </svg>

      {visibleRefs.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {visibleRefs.map((badge) => (
            <RefBadge key={`${badge.kind}:${badge.name}`} badge={badge} />
          ))}
          {extraRefs.length > 0 && (
            <span
              title={extraRefs.map((ref) => ref.name).join(', ')}
              className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-subtle px-1.5 text-caption font-medium text-tertiary tabular"
            >
              {t('graph.moreRefs', { count: extraRefs.length })}
            </span>
          )}
        </span>
      )}

      <span
        className={cn(
          'min-w-0 flex-1 truncate text-control text-primary',
          selected && 'font-medium',
        )}
        title={commit.subject}
      >
        {commit.subject}
      </span>

      <span className="hidden max-w-24 shrink-0 truncate text-caption text-tertiary sm:inline">
        {commit.authorName}
      </span>
      <span className="shrink-0 font-mono text-code-sm text-tertiary tabular">
        {commit.shortOid}
      </span>
      <span
        className="w-14 shrink-0 text-right text-caption text-placeholder tabular"
        title={fullTime(commit.authoredAt)}
      >
        {longAgo(commit.authoredAt, now)}
      </span>
    </button>
  )
}

function RefBadge({ badge }: { badge: BranchGraphRef }) {
  const icon =
    badge.kind === 'tag' ? Tag01Icon : badge.kind === 'head' ? GitCommitIcon : GitBranchIcon

  return (
    <span
      data-graph-ref={badge.name}
      data-ref-kind={badge.kind}
      data-ref-current={badge.current || undefined}
      title={badge.name}
      className={cn(
        'inline-flex h-4.5 max-w-36 shrink-0 items-center gap-1 rounded-full px-1.75 text-caption leading-none font-medium whitespace-nowrap',
        badge.current
          ? 'bg-(--primary-from) text-(--primary-foreground) ring-1 ring-inset ring-(--primary-foreground)/20'
          : badge.kind === 'tag'
            ? 'bg-warning-tint text-warning ring-1 ring-inset ring-border-subtle'
            : badge.kind === 'remote'
              ? 'bg-hover text-secondary ring-1 ring-inset ring-border-subtle'
              : 'bg-subtle text-primary ring-1 ring-inset ring-border-default',
      )}
    >
      <Glyph icon={icon} size={11} className="shrink-0" />
      <span className="min-w-0 truncate">{badge.name}</span>
    </span>
  )
}

function ContinuationRails({ lanes, width }: { lanes: readonly GraphLaneLine[]; width: number }) {
  return (
    <svg
      aria-hidden
      width={width}
      height={CONTINUATION_HEIGHT}
      viewBox={`0 0 ${width} ${CONTINUATION_HEIGHT}`}
      className="shrink-0"
    >
      {lanes.map((lane) => (
        <line
          key={`open-${lane.col}`}
          x1={xOf(lane.col)}
          y1={0}
          x2={xOf(lane.col)}
          y2={CONTINUATION_HEIGHT}
          stroke={laneColorVar(lane.color)}
          strokeWidth={1.75}
          strokeDasharray="3 3"
          strokeOpacity={0.65}
        />
      ))}
    </svg>
  )
}

function CommitInspector({
  projectPath,
  status,
  commit,
  laneColor,
  loadedOids,
  onSelectParent,
  onClose,
}: {
  projectPath: string
  status: GitStatus | undefined
  commit: BranchGraphCommit
  laneColor: string
  loadedOids: ReadonlyMap<string, BranchGraphCommit>
  onSelectParent: (oid: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('git')
  const sessionId = useLinkSessionId()
  const details = useCommit(projectPath, commit.oid, true)
  const [manualExpanded, setManualExpanded] = useState<ReadonlySet<string> | null>(null)
  const github = status?.remote?.github ?? null

  const files = details.data?.files ?? null
  const parents = details.data?.parents ?? commit.parents
  const expandedPaths = useMemo(() => {
    if (manualExpanded !== null) return manualExpanded
    const first = files?.[0]?.path
    return first ? new Set([first]) : new Set<string>()
  }, [manualExpanded, files])

  const toggleFile = useCallback(
    (path: string) => {
      setManualExpanded((prev) => {
        const base = prev ?? (files?.[0]?.path ? new Set([files[0].path]) : new Set<string>())
        return toggleExpandedPath(base, path)
      })
    },
    [files],
  )

  const insertions = files?.reduce((sum, file) => sum + (file.insertions ?? 0), 0) ?? 0
  const deletions = files?.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0

  return (
    <div data-graph-detail={commit.oid} className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-subtle px-3 py-1.5">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: laneColor }}
        />
        <span
          data-selectable=""
          className="font-mono text-code-sm font-medium text-primary tabular"
          title={commit.oid}
        >
          {commit.shortOid}
        </span>
        <CopyButton text={commit.oid} label={t('timeline.copyId')} />
        <span className="flex-1" />
        {github && (
          <Tooltip>
            <TooltipTrigger
              render={
                <a
                  {...sessionLinkProps(
                    `https://github.com/${github.owner}/${github.repo}/commit/${commit.oid}`,
                    sessionId,
                  )}
                  aria-label={t('timeline.openOnGitHub')}
                  className="inline-flex size-6 items-center justify-center rounded-md text-tertiary outline-none hover:bg-hover hover:text-primary focus-ring"
                />
              }
            >
              <Glyph icon={LinkSquare02Icon} size={13} />
            </TooltipTrigger>
            <TooltipContent>{t('timeline.openOnGitHub')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="quiet"
                size="icon-xs"
                aria-label={t('graph.closeDetails')}
                onClick={onClose}
                className="text-tertiary"
              />
            }
          >
            <Glyph icon={Cancel01Icon} size={13} />
          </TooltipTrigger>
          <TooltipContent>{t('graph.closeDetails')}</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5">
        <div className="flex flex-col gap-1.5">
          <h3
            data-selectable=""
            className="text-row leading-snug font-semibold text-primary [overflow-wrap:anywhere]"
          >
            {details.data?.subject ?? commit.subject}
          </h3>
          {details.data?.body && (
            <p
              data-selectable=""
              className="text-small leading-relaxed whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]"
            >
              {details.data.body}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-tertiary">
            <span data-selectable="" className="font-medium text-secondary">
              {details.data?.authorName ?? commit.authorName}
            </span>
            {(details.data?.authorEmail ?? commit.authorEmail) && (
              <span data-selectable="" className="font-mono text-code-sm">
                &lt;{details.data?.authorEmail ?? commit.authorEmail}&gt;
              </span>
            )}
            <span aria-hidden>·</span>
            <span data-selectable="">
              {fullTime(details.data?.authoredAt ?? commit.authoredAt)}
            </span>
          </div>
          {commit.refs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              {commit.refs.map((badge) => (
                <RefBadge key={`detail:${badge.kind}:${badge.name}`} badge={badge} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-caption text-tertiary">
            <span>
              {parents.length === 0
                ? t('graph.rootCommit')
                : parents.length === 1
                  ? t('graph.parent')
                  : t('graph.parents')}
            </span>
            {parents.map((parentOid) => {
              const shortParent = parentOid.slice(0, 7)
              const known = loadedOids.has(parentOid)
              return known ? (
                <button
                  key={parentOid}
                  type="button"
                  data-graph-parent={parentOid}
                  aria-label={t('graph.jumpToParent', { oid: shortParent })}
                  title={parentOid}
                  onClick={() => onSelectParent(parentOid)}
                  className="inline-flex h-5 items-center rounded-md bg-subtle px-1.5 font-mono text-code-sm text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:focus-ring"
                >
                  {shortParent}
                </button>
              ) : (
                <span
                  key={parentOid}
                  title={parentOid}
                  className="inline-flex h-5 items-center rounded-md bg-subtle/60 px-1.5 font-mono text-code-sm text-tertiary"
                >
                  {shortParent}
                </span>
              )
            })}
          </div>
        </div>

        <div className="mt-3 border-t border-subtle pt-2.5">
          {!details.data ? (
            details.error ? (
              <ErrorRow message={details.error} />
            ) : (
              <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-5/6" />
              </div>
            )
          ) : details.data.files.length === 0 ? (
            <p className="text-small text-tertiary">{t('graph.noChangedFiles')}</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center gap-2 text-small text-tertiary">
                <span className="font-medium text-primary">
                  {t('timeline.files', { count: details.data.files.length })}
                </span>
                <LineCounts insertions={insertions} deletions={deletions} />
              </div>
              <div className="flex flex-col gap-1">
                {details.data.files.map((file) => (
                  <CommitFileEntry
                    key={`${file.oldPath ?? ''}\0${file.path}`}
                    projectPath={projectPath}
                    status={status}
                    commitOid={commit.oid}
                    file={file}
                    expanded={expandedPaths.has(file.path)}
                    onToggle={() => toggleFile(file.path)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function CommitFileEntry({
  projectPath,
  status,
  commitOid,
  file,
  expanded,
  onToggle,
}: {
  projectPath: string
  status: GitStatus | undefined
  commitOid: string
  file: ChangedFile
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('git')
  const regionId = useId()
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const folder = slash < 0 ? '' : file.path.slice(0, slash).split('/').slice(-2).join('/')
  const openFullDiff = status ? () => openChangeDiff(status, file, commitOid, KEPT) : undefined

  return (
    <div
      data-graph-file={file.path}
      data-expanded={expanded || undefined}
      className={cn(
        'rounded-xl transition-colors',
        expanded ? 'bg-card shadow-card' : 'hover:bg-hover',
      )}
    >
      <div className="flex h-8 items-center gap-2 px-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={regionId}
          aria-label={t(expanded ? 'pane.changes.collapseDiff' : 'pane.changes.expandDiff', {
            name,
          })}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          onClick={onToggle}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:focus-ring"
        >
          <Glyph
            icon={ArrowRight01Icon}
            size={12}
            className={cn(
              'shrink-0 text-placeholder transition-transform duration-(--duration-fast) motion-reduce:transition-none',
              expanded && 'rotate-90 text-secondary',
            )}
          />
          <ChangeBadge status={file.status} />
          <span className="min-w-0 shrink truncate text-ui text-primary">{name}</span>
          <span className="min-w-0 flex-1 truncate text-small text-tertiary">{folder}</span>
        </button>
        {openFullDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="quiet"
                  size="icon-xs"
                  aria-label={t('pane.changes.openDiffTab')}
                  onClick={(event) => {
                    event.stopPropagation()
                    openFullDiff()
                  }}
                  className="shrink-0 text-tertiary"
                />
              }
            >
              <Glyph icon={LinkSquare02Icon} size={13} />
            </TooltipTrigger>
            <TooltipContent>{t('pane.changes.openDiffTab')}</TooltipContent>
          </Tooltip>
        )}
        <LineCounts insertions={file.insertions} deletions={file.deletions} />
      </div>
      {expanded && (
        <CommitFileDiff
          id={regionId}
          name={name}
          projectPath={projectPath}
          commitOid={commitOid}
          file={file}
          onOpenTab={openFullDiff}
        />
      )}
    </div>
  )
}

function CommitFileDiff({
  id,
  name,
  projectPath,
  commitOid,
  file,
  onOpenTab,
}: {
  id: string
  name: string
  projectPath: string
  commitOid: string
  file: ChangedFile
  onOpenTab?: () => void
}) {
  const { t } = useTranslation('git')
  const { data, error, retry } = useCommitFileDiff(projectPath, commitOid, file, true)
  const view = useMemo(() => prepareInlineDiff(file, data, error), [file, data, error])

  let body
  if (view.kind === 'loading') {
    body = (
      <div className="flex flex-col gap-1.5 px-3 py-3" aria-busy="true">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    )
  } else if (view.kind === 'error') {
    body = (
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <ErrorRow message={view.error} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={retry}>
            {t('pane.changes.retry')}
          </Button>
          {onOpenTab && (
            <Button variant="quiet" size="xs" onClick={onOpenTab}>
              {t('pane.changes.openFullDiff')}
            </Button>
          )}
        </div>
      </div>
    )
  } else if (view.kind !== 'diff') {
    const message =
      view.kind === 'binary'
        ? t('pane.changes.binary')
        : view.kind === 'too-large'
          ? t('pane.changes.tooLarge')
          : view.kind === 'renamed-only'
            ? t('pane.changes.renamedOnly', { oldPath: view.oldPath })
            : view.kind === 'empty-added'
              ? t('pane.changes.emptyAdded')
              : view.kind === 'empty-deleted'
                ? t('pane.changes.emptyDeleted')
                : t('pane.changes.same')
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <p className="min-w-0 text-small text-tertiary [overflow-wrap:anywhere]">{message}</p>
        {onOpenTab && (
          <Button variant="quiet" size="xs" onClick={onOpenTab} className="shrink-0">
            {t('pane.changes.openFullDiff')}
          </Button>
        )}
      </div>
    )
  } else {
    body = (
      <>
        {file.oldPath && file.oldPath !== file.path && (
          <div
            className="truncate border-b border-subtle bg-subtle/60 px-3 py-1 font-mono text-code-sm text-tertiary"
            title={`${file.oldPath} → ${file.path}`}
          >
            {file.oldPath} → {file.path}
          </div>
        )}
        <div className="max-h-80 overflow-auto overscroll-contain">
          <Diff
            path={file.path}
            oldText={view.oldText}
            newText={view.newText}
            overflow="scroll"
            layout="unified"
            className="git-inline-diff"
          />
        </div>
        {view.truncated && (
          <div className="flex items-center justify-between gap-2 border-t border-subtle bg-subtle/60 px-3 py-1.5 text-small text-tertiary">
            <span className="min-w-0 truncate">
              {view.totalLines !== null
                ? t('pane.changes.truncated', {
                    shown: view.shownLines,
                    total: view.totalLines,
                  })
                : t('pane.changes.truncatedGeneric')}
            </span>
            {onOpenTab && (
              <Button variant="quiet" size="xs" onClick={onOpenTab} className="shrink-0">
                {t('pane.changes.openFullDiff')}
              </Button>
            )}
          </div>
        )}
      </>
    )
  }

  return (
    <div
      id={id}
      role="region"
      aria-label={t('pane.changes.inlineDiffRegion', { name })}
      data-graph-file-diff={file.path}
      className="overflow-hidden rounded-b-xl border-t border-subtle"
    >
      {body}
    </div>
  )
}

function GraphLoading() {
  return (
    <div className="flex flex-col gap-2 px-3 py-3" aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-3">
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${78 - (index % 4) * 12}%` }} />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  )
}
