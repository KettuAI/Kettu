import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive01Icon,
  ArrowDown01Icon,
  ArrowMoveDownRightIcon,
  ArrowRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  FolderMinusIcon,
  GitBranchIcon,
  Search01Icon,
  Tick02Icon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { deleteSession, unarchiveProject, unarchiveSession } from '@renderer/app/actions'
import { popupOpen } from '@renderer/app/shortcuts'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { toast } from '@renderer/components/ui/toast'
import { useNearView } from '@renderer/features/session/media/near-view'
import { ProjectMark } from '@renderer/features/shell/project-icon'
import { RemoveProjectDialog } from '@renderer/features/sidebar/remove-project'
import { offerWorktreeRemoval } from '@renderer/features/worktrees/remove-worktree-model'
import { fullTime, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import { archivedSessions, useSessionsStore } from '@renderer/stores/sessions'
import { openSearch, openSession } from '@renderer/stores/view'
import {
  agentFacets,
  buildArchivedEntries,
  buildArchivedProjects,
  filterArchivedEntries,
  formatArchivedWhen,
  formatMonthHeading,
  groupArchivedEntries,
  highlightMatches,
  projectFacets,
  queryWords,
  readArchivedGroupBy,
  saveArchivedGroupBy,
  type ArchivedDateBucket,
  type ArchivedEntry,
  type ArchivedGroup,
  type ArchivedGroupBy,
  type ArchivedProjectEntry,
  type FacetOption,
} from './archived-model'
import { CONFIRM, IconAction, Segmented, SetButton } from './controls'
import { EmptyCard } from './rows'

/** Rows drawn in full on first paint; the rest upgrade as they near the viewport or when idle. */
const ARCHIVED_EAGER = 30
const IDLE_BATCH = 30
const IDLE_WAIT_MS = 50
/** Maximum rows shown inside the bulk delete list before it scrolls. */
const DELETE_LIST_CAP = 8

const toDraw = new Set<() => void>()
let drawing = false

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: IDLE_WAIT_MS })
  else setTimeout(run, IDLE_WAIT_MS)
}

function drawWhenIdle(draw: () => void): () => void {
  toDraw.add(draw)
  if (!drawing) {
    drawing = true
    whenIdle(drawBatch)
  }
  return () => toDraw.delete(draw)
}

function drawBatch(): void {
  let drawn = 0
  for (const draw of toDraw) {
    if (drawn++ === IDLE_BATCH) break
    toDraw.delete(draw)
    draw()
  }
  drawing = toDraw.size > 0
  if (drawing) whenIdle(drawBatch)
}

function Highlight({ text, query }: { text: string; query: string }) {
  const parts = highlightMatches(text, query)
  if (parts.length === 1 && !parts[0]!.match) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>,
      )}
    </>
  )
}

/**
 * Settings > Archived sessions: toolbar (search, Project and Agent filter menus, By date / By
 * project switch), grouped single-line rows, read-only open on click, and multi-select restore and
 * delete. Grouping is remembered per computer; search and filters clear each time the page opens.
 */
export function ArchivedSection() {
  const { t } = useTranslation(['settings', 'sidebar', 'common'])
  const { hostId } = useHostScope()
  const otherHost = useOtherHost(hostId)
  const away = isAway(otherHost?.connection ?? null)
  const now = useNow()
  const byId = useSessionsStore((s) => s.byId)
  const archived = useSessionsStore(useShallow((s) => archivedSessions(s.byId, hostId)))
  const projects = useProjectsStore((s) => s.projects)

  const [groupBy, setGroupBy] = useState<ArchivedGroupBy>(readArchivedGroupBy)
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [agentFilter, setAgentFilter] = useState<AgentId | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [busyRestore, setBusyRestore] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<ArchivedEntry[] | null>(null)
  const [removingProject, setRemovingProject] = useState<{
    project: Project
    open: boolean
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const noProjectLabel = t('sidebar:project.noProject')

  const archivedProjectEntries = useMemo(
    () => buildArchivedProjects(projects, byId, hostId),
    [projects, byId, hostId],
  )
  const entries = useMemo(
    () => buildArchivedEntries(archived, byId, projects, hostId, noProjectLabel),
    [archived, byId, projects, hostId, noProjectLabel],
  )
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.summary.id, entry])),
    [entries],
  )

  const words = useMemo(() => queryWords(query), [query])
  const projectMenu = useMemo(
    () => projectFacets(entries, words, agentFilter),
    [entries, words, agentFilter],
  )
  const agentMenu = useMemo(
    () => agentFacets(entries, words, projectFilter),
    [entries, words, projectFilter],
  )

  const activeProject = useMemo(
    () => (projectFilter ? (entries.find((e) => e.projectKey === projectFilter) ?? null) : null),
    [entries, projectFilter],
  )
  const activeAgent = useMemo(
    () => (agentFilter ? (entries.find((e) => e.agentId === agentFilter) ?? null) : null),
    [entries, agentFilter],
  )

  const filtered = useMemo(
    () => filterArchivedEntries(entries, words, projectFilter, agentFilter),
    [entries, words, projectFilter, agentFilter],
  )
  const groups = useMemo(
    () => groupArchivedEntries(filtered, groupBy, now),
    [filtered, groupBy, now],
  )
  const groupOffsets = useMemo(() => {
    const offsets: number[] = []
    let acc = 0
    for (const group of groups) {
      offsets.push(acc)
      if (!(group.kind === 'project' && collapsed.has(group.id))) acc += group.entries.length
    }
    return offsets
  }, [groups, collapsed])
  const totalProjects = useMemo(() => new Set(entries.map((e) => e.projectKey)).size, [entries])

  // Keep selection narrowed to entries that still exist in the current host's archived list.
  const activeSelected = useMemo(() => {
    if (selected.size === 0) return selected
    const kept = new Set<string>()
    for (const id of selected) {
      if (entryById.has(id)) kept.add(id)
    }
    return kept
  }, [selected, entryById])

  const selecting = activeSelected.size > 0
  const hasFilters = words.length > 0 || projectFilter !== null || agentFilter !== null

  // Esc clears the multi-selection before it closes Settings.
  useEffect(() => {
    if (!selecting) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || popupOpen()) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setSelected(new Set())
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [selecting])

  const changeGroupBy = (next: ArchivedGroupBy) => {
    setGroupBy(next)
    saveArchivedGroupBy(next)
  }

  const clearFilters = () => {
    setQuery('')
    setProjectFilter(null)
    setAgentFilter(null)
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroupSelection = (group: ArchivedGroup) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = group.entries.every((e) => next.has(e.summary.id))
      for (const e of group.entries) {
        if (allOn) next.delete(e.summary.id)
        else next.add(e.summary.id)
      }
      return next
    })
  }

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const restoreOne = async (entry: ArchivedEntry) => {
    try {
      await unarchiveSession(entry.summary.id)
      toast(
        entry.parentTitle === null
          ? t('archived.restored', { project: entry.projectLabel })
          : t('archived.restoredUnder', { title: entry.parentTitle }),
      )
    } catch (error) {
      toast(errorMessage(error))
    }
  }

  const restoreSelected = async () => {
    const ids = [...activeSelected]
    if (ids.length === 0 || busyRestore) return
    setBusyRestore(true)
    let done = 0
    const failed = new Set<string>()
    let firstError: string | null = null
    for (const id of ids) {
      try {
        await unarchiveSession(id)
        done += 1
      } catch (error) {
        failed.add(id)
        if (firstError === null) firstError = errorMessage(error)
      }
    }
    setBusyRestore(false)
    setSelected(failed)
    if (firstError !== null) {
      toast(
        done > 0
          ? t('archived.restoredSome', { done, total: ids.length, error: firstError })
          : firstError,
      )
    } else if (done === 1) {
      const entry = entryById.get(ids[0]!)
      if (entry) {
        toast(
          entry.parentTitle === null
            ? t('archived.restored', { project: entry.projectLabel })
            : t('archived.restoredUnder', { title: entry.parentTitle }),
        )
      }
    } else if (done > 1) {
      toast(t('archived.restoredCount', { count: done }))
    }
  }

  const openConversationsSearch = () => {
    const trimmed = query.trim()
    openSearch({ scope: 'conversations', ...(trimmed ? { query: trimmed } : {}) })
  }

  const headingLabel = (group: ArchivedGroup): string => {
    if (group.kind === 'project') return group.projectLabel ?? noProjectLabel
    const bucket = group.bucket!
    switch (bucket.kind) {
      case 'today':
        return t('archived.date.today')
      case 'yesterday':
        return t('archived.date.yesterday')
      case 'earlierThisWeek':
        return t('archived.date.earlierThisWeek')
      case 'earlierThisMonth':
        return t('archived.date.earlierThisMonth')
      case 'month':
        return formatMonthHeading(bucket.year, bucket.month, bucket.currentYear)
    }
  }

  const toggleProjectExpand = (path: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const restoreProject = async (project: Project) => {
    try {
      await unarchiveProject(project.path)
      toast(t('archived.projectRestored', { name: project.name }))
    } catch (error) {
      toast(errorMessage(error))
    }
  }

  if (archivedProjectEntries.length === 0 && entries.length === 0) {
    return <EmptyCard title={t('archived.emptyTitle')} hint={t('archived.emptyHint')} />
  }

  // Quick-select action for the floating bar: either the single group being picked from, or all
  // currently visible filtered entries.
  const selectedGroups = groups.filter((g) =>
    g.entries.some((e) => activeSelected.has(e.summary.id)),
  )
  const singleGroup = selectedGroups.length === 1 ? selectedGroups[0]! : null
  const singleGroupIncomplete =
    singleGroup !== null && singleGroup.entries.some((e) => !activeSelected.has(e.summary.id))
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((e) => activeSelected.has(e.summary.id))

  return (
    <div className="k-ar">
      {archivedProjectEntries.length > 0 && (
        <section className="k-ar-proj-sec" aria-label={t('archived.projectsHeading')}>
          <div className="k-ar-gh">
            <h2 className="k-ar-gh__title">{t('archived.projectsHeading')}</h2>
            <span className="k-ar-gh__count k-num">{archivedProjectEntries.length}</span>
          </div>
          <div className="k-ar-proj-list">
            {archivedProjectEntries.map((entry) => (
              <ArchivedProjectCard
                key={entry.project.path}
                entry={entry}
                hostId={hostId}
                now={now}
                away={away}
                expanded={expandedProjects.has(entry.project.path)}
                onToggle={() => toggleProjectExpand(entry.project.path)}
                onRestore={() => restoreProject(entry.project)}
                onRemove={() => setRemovingProject({ project: entry.project, open: true })}
              />
            ))}
          </div>
        </section>
      )}

      {entries.length > 0 && (
        <>
          {archivedProjectEntries.length > 0 && (
            <div className="k-ar-gh k-ar-sess-head">
              <h2 className="k-ar-gh__title">{t('archived.sessionsHeading')}</h2>
              <span className="k-ar-gh__count k-num">{entries.length}</span>
            </div>
          )}
          <div className="k-ar-tb">
            <label className={cn('k-ar-search', query.length > 0 && 'is-has')}>
              <Icon icon={Search01Icon} size={14} />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('archived.searchPlaceholder')}
                aria-label={t('archived.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
                  event.stopPropagation()
                  if (query) setQuery('')
                  else event.currentTarget.blur()
                }}
              />
              {query && (
                <button
                  type="button"
                  className="k-ar-search__clear"
                  aria-label={t('page.clearSearch')}
                  onClick={() => {
                    setQuery('')
                    searchInputRef.current?.focus()
                  }}
                >
                  <Icon icon={Cancel01Icon} size={12} />
                </button>
              )}
            </label>

            <ProjectFilterMenu
              value={projectFilter}
              selectedLabel={activeProject?.projectLabel ?? null}
              total={projectMenu.total}
              options={projectMenu.options}
              onChange={setProjectFilter}
            />

            <AgentFilterMenu
              value={agentFilter}
              selectedLabel={activeAgent?.agentLabel ?? null}
              total={agentMenu.total}
              options={agentMenu.options}
              hostId={hostId}
              onChange={setAgentFilter}
            />

            <Segmented<ArchivedGroupBy>
              label={t('archived.groupBy')}
              value={groupBy}
              options={[
                { value: 'date', label: t('archived.byDate') },
                { value: 'project', label: t('archived.byProject') },
              ]}
              onChange={changeGroupBy}
            />
          </div>

          <div className="k-ar-count">
            {hasFilters ? (
              <>
                <span className="k-num">
                  {t('archived.filteredCount', { shown: filtered.length, total: entries.length })}
                </span>
                <span aria-hidden="true">·</span>
                <button type="button" className="k-ar-link" onClick={clearFilters}>
                  {t('archived.clearFilters')}
                </button>
              </>
            ) : groupBy === 'project' ? (
              <span className="k-num">
                {t('archived.countInProjects', {
                  sessions: t('archived.count', { count: entries.length }),
                  projects: t('archived.projectCount', { count: totalProjects }),
                })}
              </span>
            ) : (
              <span className="k-num">{t('archived.count', { count: entries.length })}</span>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="k-ar-empty">
              <div className="k-ar-empty__ico" aria-hidden="true">
                <Icon icon={Archive01Icon} size={20} />
              </div>
              <p className="k-ar-empty__title">{t('archived.noMatchTitle')}</p>
              <p className="k-ar-empty__sub">
                {noMatchDescription(
                  t,
                  query.trim(),
                  activeProject?.projectLabel ?? null,
                  activeAgent?.agentLabel ?? null,
                )}
              </p>
              <div className="k-ar-empty__actions">
                <SetButton size="sm" onClick={clearFilters}>
                  {t('archived.clearFilters')}
                </SetButton>
                <SetButton
                  size="sm"
                  variant="ghost"
                  iconRight={<Icon icon={ArrowRight01Icon} size={13} />}
                  onClick={openConversationsSearch}
                >
                  {t('archived.searchConversations')}
                </SetButton>
              </div>
            </div>
          ) : (
            <>
              <div className="k-ar-groups">
                {groups.map((group, groupIndex) => {
                  const title = headingLabel(group)
                  const startOffset = groupOffsets[groupIndex] ?? 0
                  const isCollapsed = group.kind === 'project' && collapsed.has(group.id)
                  const selectedInGroup = group.entries.filter((e) =>
                    activeSelected.has(e.summary.id),
                  ).length
                  const allInGroup = selectedInGroup === group.entries.length && selectedInGroup > 0
                  const someInGroup = selectedInGroup > 0 && selectedInGroup < group.entries.length

                  return (
                    <section key={group.id} aria-label={title} className="k-ar-group">
                      <div className={cn('k-ar-gh', selecting && 'is-selecting')}>
                        {selecting && (
                          <Checkbox
                            checked={allInGroup}
                            indeterminate={someInGroup}
                            aria-label={t('archived.selectGroup', { group: title })}
                            onCheckedChange={() => toggleGroupSelection(group)}
                          />
                        )}
                        {group.kind === 'project' ? (
                          <button
                            type="button"
                            className="k-ar-gh__toggle"
                            aria-expanded={!isCollapsed}
                            onClick={() => toggleCollapse(group.id)}
                          >
                            <span className="k-ar-gh__fold" aria-hidden="true">
                              <Icon
                                icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                                size={12}
                              />
                            </span>
                            <ProjectMark
                              icon={group.projectIcon}
                              size={14}
                              fallback="folder-glyph"
                            />
                            <span className="k-ar-gh__title">{title}</span>
                            <span className="k-ar-gh__count k-num">{group.entries.length}</span>
                          </button>
                        ) : (
                          <>
                            <h2 className="k-ar-gh__title">{title}</h2>
                            <span className="k-ar-gh__count k-num">{group.entries.length}</span>
                          </>
                        )}
                      </div>

                      {!isCollapsed && (
                        <div className="k-ar-rows">
                          {group.entries.map((entry, idx) => (
                            <ArchivedRow
                              key={entry.summary.id}
                              entry={entry}
                              mode={groupBy}
                              bucket={group.bucket}
                              query={query}
                              hostId={hostId}
                              now={now}
                              eager={startOffset + idx < ARCHIVED_EAGER}
                              selecting={selecting}
                              checked={activeSelected.has(entry.summary.id)}
                              onToggle={() => toggleSelect(entry.summary.id)}
                              onOpen={() =>
                                openSession(entry.summary.id, entry.summary.projectPath)
                              }
                              onRestore={() => void restoreOne(entry)}
                              onDelete={() => setDeleteTargets([entry])}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>

              {words.length > 0 && (
                <div className="k-ar-conv-hint">
                  <span>{t('archived.searchConversationsPrompt')}</span>
                  <button type="button" className="k-ar-link" onClick={openConversationsSearch}>
                    {t('archived.searchConversations')}
                    <Icon icon={ArrowRight01Icon} size={12} />
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {selecting && (
        <div className="k-ar-selbar" role="region" aria-label={t('archived.selectionBar')}>
          <span className="k-ar-selbar__n k-num">
            {t('archived.selectedCount', { count: activeSelected.size })}
          </span>
          {singleGroupIncomplete && singleGroup ? (
            <button
              type="button"
              className="k-ar-link k-ar-selbar__all"
              onClick={() => toggleGroupSelection(singleGroup)}
            >
              {t('archived.selectAllInGroup', {
                count: singleGroup.entries.length,
                group: headingLabel(singleGroup),
              })}
            </button>
          ) : (
            !allVisibleSelected &&
            filtered.length > activeSelected.size && (
              <button
                type="button"
                className="k-ar-link k-ar-selbar__all"
                onClick={() => setSelected(new Set(filtered.map((e) => e.summary.id)))}
              >
                {t('archived.selectAll', { count: filtered.length })}
              </button>
            )
          )}
          <span className="k-ar-selbar__sep" aria-hidden="true" />
          <SetButton
            size="sm"
            loading={busyRestore}
            icon={<Icon icon={Undo02Icon} size={14} />}
            onClick={() => void restoreSelected()}
          >
            {t('archived.restore')}
          </SetButton>
          <SetButton
            size="sm"
            variant="secondary"
            className="k-ar-selbar__del"
            icon={<Icon icon={Delete02Icon} size={14} />}
            disabled={busyRestore}
            onClick={() => {
              const items = [...activeSelected]
                .map((id) => entryById.get(id))
                .filter((e): e is ArchivedEntry => !!e)
              if (items.length > 0) setDeleteTargets(items)
            }}
          >
            {t('archived.delete')}
          </SetButton>
          <IconAction
            label={t('archived.clearSelection')}
            icon={Cancel01Icon}
            onClick={() => setSelected(new Set())}
          />
        </div>
      )}

      <DeleteArchivedDialog
        targets={deleteTargets}
        hostId={hostId}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets(null)
        }}
        onDeleted={(removedIds) => {
          setSelected((prev) => {
            if (prev.size === 0) return prev
            const next = new Set(prev)
            for (const id of removedIds) next.delete(id)
            return next
          })
        }}
      />

      {removingProject && (
        <RemoveProjectDialog
          project={removingProject.project}
          open={removingProject.open}
          onOpenChange={(open) => setRemovingProject({ ...removingProject, open })}
        />
      )}
    </div>
  )
}

function ArchivedProjectCard({
  entry,
  hostId,
  now,
  away,
  expanded,
  onToggle,
  onRestore,
  onRemove,
}: {
  entry: ArchivedProjectEntry
  hostId: string | null
  now: number
  away: boolean
  expanded: boolean
  onToggle: () => void
  onRestore: () => Promise<void>
  onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const [restoring, setRestoring] = useState(false)
  const { project, sessions } = entry
  const folderTitle = entry.folders.map(hostPath).join('\n')

  const handleRestore = async () => {
    if (restoring || away) return
    setRestoring(true)
    try {
      await onRestore()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="k-ar-proj" data-archived-project={project.path}>
      <div className="k-ar-proj__head">
        <button
          type="button"
          className="k-ar-proj__toggle"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'archived.collapseProject' : 'archived.expandProject', {
            name: project.name,
          })}
          onClick={onToggle}
        >
          <span className="k-ar-gh__fold" aria-hidden="true">
            <Icon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
          </span>
          <ProjectMark icon={project.icon} size={16} fallback="folder-glyph" />
          <span className="k-ar-proj__meta">
            <span className="k-ar-proj__name-line">
              <span className="k-ar-proj__name">{project.name}</span>
              {project.missing && <span className="k-ar-kids">{t('archived.projectMissing')}</span>}
            </span>
            <span className="k-ar-proj__path" title={folderTitle}>
              {hostPath(project.path)}
            </span>
          </span>
          <span className="k-ar-kids k-num">{t('archived.count', { count: sessions.length })}</span>
        </button>

        <span
          className="k-ar-when k-num"
          title={t('archived.projectArchivedAt', { when: fullTime(entry.archivedAt) })}
        >
          {mediumAgo(entry.archivedAt, now)}
        </span>

        <span className="k-ar-proj__acts">
          <SetButton
            size="sm"
            disabled={away}
            loading={restoring}
            icon={<Icon icon={Undo02Icon} size={13} />}
            onClick={() => void handleRestore()}
          >
            {t('archived.restoreProject')}
          </SetButton>
          <IconAction
            label={t('archived.removeProject')}
            icon={FolderMinusIcon}
            danger
            disabled={away}
            onClick={onRemove}
          />
        </span>
      </div>

      {expanded && (
        <div className="k-ar-proj__sessions">
          {sessions.length === 0 ? (
            <div className="k-ar-proj__empty">{t('archived.projectNoSessions')}</div>
          ) : (
            sessions.map((item) => (
              <div
                key={item.summary.id}
                className="k-ar-row"
                data-archived-project-session={item.summary.id}
              >
                <button
                  type="button"
                  className="k-ar-hit"
                  aria-label={t('archived.openRow', { title: item.title })}
                  onClick={() => openSession(item.summary.id, item.summary.projectPath)}
                />
                <span className="k-ar-lead">
                  <AgentMark agent={item.agentId} size={16} hostId={hostId} />
                </span>
                <span className="k-ar-title" title={item.title}>
                  {item.title}
                </span>
                {item.subSessionCount > 0 && (
                  <span className="k-ar-kids">
                    <Icon icon={ArrowRight01Icon} size={11} />
                    {t('archived.subSessions', { count: item.subSessionCount })}
                  </span>
                )}
                {item.sessionArchived && (
                  <span className="k-ar-kids">{t('archived.projectSessionArchived')}</span>
                )}
                <span className="k-ar-sp" />
                {item.branch !== null && (
                  <span className="k-ar-br" title={item.branch}>
                    <Icon icon={GitBranchIcon} size={12} />
                    <span className="k-ar-br__t">{item.branch}</span>
                  </span>
                )}
                <span className="k-ar-when k-num" title={fullTime(item.updatedAt)}>
                  {mediumAgo(item.updatedAt, now)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function noMatchDescription(
  t: ReturnType<typeof useTranslation<'settings'>>['t'],
  query: string,
  project: string | null,
  agent: string | null,
): string {
  if (query && project && agent) {
    return t('archived.noMatchQueryProjectAgent', { query, project, agent })
  }
  if (query && project) return t('archived.noMatchQueryProject', { query, project })
  if (query && agent) return t('archived.noMatchQueryAgent', { query, agent })
  if (query) return t('archived.noMatchQuery', { query })
  if (project && agent) return t('archived.noMatchProjectAgent', { project, agent })
  return t('archived.noMatchGeneric')
}

function ProjectFilterMenu({
  value,
  selectedLabel,
  total,
  options,
  onChange,
}: {
  value: string | null
  selectedLabel: string | null
  total: number
  options: readonly FacetOption[]
  onChange: (next: string | null) => void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [find, setFind] = useState('')
  const needle = find.trim().toLowerCase()
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options

  const pick = (next: string | null) => {
    onChange(next)
    setOpen(false)
    setFind('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setFind('')
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn('k-ar-fb', value !== null && 'is-set')}
            aria-label={t('archived.filterProject')}
          />
        }
      >
        <span className="k-ar-fb__label">
          {t('archived.project')}
          {selectedLabel !== null && (
            <>
              {': '}
              <span className="k-ar-fb__val">{selectedLabel}</span>
            </>
          )}
        </span>
        <Icon icon={ArrowDown01Icon} size={12} />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="k-ar-pop">
        {options.length > 1 && (
          <label className="k-ar-pop__search">
            <Icon icon={Search01Icon} size={14} />
            <input
              type="text"
              value={find}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={t('archived.findProject')}
              aria-label={t('archived.findProject')}
              onChange={(e) => setFind(e.target.value)}
            />
          </label>
        )}
        <div className="k-ar-pop__list" role="listbox" aria-label={t('archived.filterProject')}>
          {needle === '' && (
            <>
              <button
                type="button"
                role="option"
                aria-selected={value === null}
                className={cn('k-ar-mi', value === null && 'is-on')}
                onClick={() => pick(null)}
              >
                <span className="k-ar-mi__ck">
                  {value === null && <Icon icon={Tick02Icon} size={14} />}
                </span>
                <span className="k-ar-mi__t">{t('archived.allProjects')}</span>
                <span className="k-ar-mi__k k-num">{total}</span>
              </button>
              {options.length > 0 && <div className="k-ar-pop__div" />}
            </>
          )}
          {shown.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={value === opt.id}
              className={cn('k-ar-mi', value === opt.id && 'is-on')}
              onClick={() => pick(opt.id)}
            >
              <span className="k-ar-mi__ck">
                {value === opt.id && <Icon icon={Tick02Icon} size={14} />}
              </span>
              <span className="k-ar-mi__ico" aria-hidden="true">
                <ProjectMark icon={opt.icon} size={14} fallback="folder-glyph" />
              </span>
              <span className="k-ar-mi__t">{opt.label}</span>
              <span className="k-ar-mi__k k-num">{opt.count}</span>
            </button>
          ))}
          {shown.length === 0 && (
            <div className="k-ar-pop__empty">{t('archived.noProjectMatch')}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AgentFilterMenu({
  value,
  selectedLabel,
  total,
  options,
  hostId,
  onChange,
}: {
  value: AgentId | null
  selectedLabel: string | null
  total: number
  options: readonly (FacetOption & { agentId: AgentId })[]
  hostId: string | null
  onChange: (next: AgentId | null) => void
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)

  const pick = (next: AgentId | null) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn('k-ar-fb', value !== null && 'is-set')}
            aria-label={t('archived.filterAgent')}
          />
        }
      >
        <span className="k-ar-fb__label">
          {t('archived.agent')}
          {selectedLabel !== null && (
            <>
              {': '}
              <span className="k-ar-fb__val">{selectedLabel}</span>
            </>
          )}
        </span>
        <Icon icon={ArrowDown01Icon} size={12} />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="k-ar-pop">
        <div className="k-ar-pop__list" role="listbox" aria-label={t('archived.filterAgent')}>
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            className={cn('k-ar-mi', value === null && 'is-on')}
            onClick={() => pick(null)}
          >
            <span className="k-ar-mi__ck">
              {value === null && <Icon icon={Tick02Icon} size={14} />}
            </span>
            <span className="k-ar-mi__t">{t('archived.allAgents')}</span>
            <span className="k-ar-mi__k k-num">{total}</span>
          </button>
          {options.length > 0 && <div className="k-ar-pop__div" />}
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="option"
              aria-selected={value === opt.agentId}
              className={cn('k-ar-mi', value === opt.agentId && 'is-on')}
              onClick={() => pick(opt.agentId)}
            >
              <span className="k-ar-mi__ck">
                {value === opt.agentId && <Icon icon={Tick02Icon} size={14} />}
              </span>
              <span className="k-ar-mi__ico" aria-hidden="true">
                <AgentMark agent={opt.agentId} size={15} hostId={hostId} />
              </span>
              <span className="k-ar-mi__t">{opt.label}</span>
              <span className="k-ar-mi__k k-num">{opt.count}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ArchivedRow({
  entry,
  mode,
  bucket,
  query,
  hostId,
  now,
  eager,
  selecting,
  checked,
  onToggle,
  onOpen,
  onRestore,
  onDelete,
}: {
  entry: ArchivedEntry
  mode: ArchivedGroupBy
  bucket: ArchivedDateBucket | undefined
  query: string
  hostId: string | null
  now: number
  eager: boolean
  selecting: boolean
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearView(ref, !eager, '.kettu-settings__page')
  const [idle, setIdle] = useState(false)
  useEffect(() => (eager ? undefined : drawWhenIdle(() => setIdle(true))), [eager])

  if (eager || near || idle || selecting || checked) {
    return (
      <FullArchivedRow
        entry={entry}
        mode={mode}
        bucket={bucket}
        query={query}
        hostId={hostId}
        now={now}
        selecting={selecting}
        checked={checked}
        onToggle={onToggle}
        onOpen={onOpen}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    )
  }

  const when = formatArchivedWhen(entry.archivedAt, mode, bucket, now)
  return (
    <div ref={ref} className="k-ar-row">
      <span className="k-ar-lead">
        <AgentMark agent={entry.agentId} size={16} hostId={hostId} />
      </span>
      <span className="k-ar-title">{entry.title}</span>
      <span className="k-ar-sp" />
      {mode === 'date' && <span className="k-ar-pj">{entry.projectLabel}</span>}
      <span className="k-ar-when k-num">{when}</span>
    </div>
  )
}

function FullArchivedRow({
  entry,
  mode,
  bucket,
  query,
  hostId,
  now,
  selecting,
  checked,
  onToggle,
  onOpen,
  onRestore,
  onDelete,
}: {
  entry: ArchivedEntry
  mode: ArchivedGroupBy
  bucket: ArchivedDateBucket | undefined
  query: string
  hostId: string | null
  now: number
  selecting: boolean
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('settings')
  const [restoring, setRestoring] = useState(false)
  const when = formatArchivedWhen(entry.archivedAt, mode, bucket, now)

  const handleRestore = async () => {
    if (restoring) return
    setRestoring(true)
    try {
      await onRestore()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div
      className={cn('k-ar-row', selecting && 'is-selecting', checked && 'is-sel')}
      data-archived-row={entry.summary.id}
    >
      {/* Full-row hit target behind interactive controls so clicks open the session read-only (or
          toggle selection while multi-selecting) without nesting interactive elements. */}
      <button
        type="button"
        className="k-ar-hit"
        aria-label={
          selecting
            ? t('archived.toggleRow', { title: entry.title })
            : t('archived.openRow', { title: entry.title })
        }
        onClick={selecting ? onToggle : onOpen}
      />

      <span className="k-ar-lead">
        <span className="k-ar-lead__mark" aria-hidden="true">
          <AgentMark agent={entry.agentId} size={16} hostId={hostId} />
        </span>
        <span className="k-ar-lead__cbx">
          <Checkbox
            checked={checked}
            aria-label={t('archived.selectRow', { title: entry.title })}
            onCheckedChange={onToggle}
          />
        </span>
      </span>

      <span className="k-ar-title" title={entry.title}>
        <Highlight text={entry.title} query={query} />
      </span>

      {entry.parentTitle !== null && (
        <span className="k-ar-sub" title={t('archived.parent', { title: entry.parentTitle })}>
          <Icon icon={ArrowMoveDownRightIcon} size={12} />
          <span className="k-ar-sub__t">
            <Highlight text={entry.parentTitle} query={query} />
          </span>
        </span>
      )}

      {entry.subSessionCount > 0 && (
        <span className="k-ar-kids">
          <Icon icon={ArrowRight01Icon} size={11} />
          {t('archived.subSessions', { count: entry.subSessionCount })}
        </span>
      )}

      <span className="k-ar-sp" />

      {entry.branch !== null && (
        <span className="k-ar-br" title={entry.branch}>
          <Icon icon={GitBranchIcon} size={12} />
          <span className="k-ar-br__t">
            <Highlight text={entry.branch} query={query} />
          </span>
        </span>
      )}

      {mode === 'date' && (
        <span className="k-ar-pj" title={entry.projectLabel}>
          <Highlight text={entry.projectLabel} query={query} />
        </span>
      )}

      <span className="k-ar-when k-num" title={fullTime(entry.archivedAt)}>
        {when}
      </span>

      {!selecting && (
        <span className="k-ar-acts">
          <SetButton
            size="sm"
            loading={restoring}
            icon={<Icon icon={Undo02Icon} size={13} />}
            onClick={() => void handleRestore()}
          >
            {t('archived.restore')}
          </SetButton>
          <IconAction label={t('archived.delete')} icon={Delete02Icon} danger onClick={onDelete} />
        </span>
      )}
    </div>
  )
}

function DeleteArchivedDialog({
  targets,
  hostId,
  onOpenChange,
  onDeleted,
}: {
  targets: ArchivedEntry[] | null
  hostId: string | null
  onOpenChange: (open: boolean) => void
  onDeleted: (removedIds: string[]) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  // Keep the last targets while the dialog animates out so its title and list do not flash empty.
  const [shown, setShown] = useState<ArchivedEntry[]>([])
  if (targets !== null && targets !== shown) setShown(targets)
  const open = targets !== null
  const several = shown.length > 1
  const subTotal = shown.reduce((sum, e) => sum + e.subSessionCount, 0)
  const first = shown[0]

  const confirmDelete = async () => {
    const list = shown
    onOpenChange(false)
    if (list.length === 0) return
    await offerWorktreeRemoval(
      list.map((e) => e.summary),
      'deleting',
    )
    const removed: string[] = []
    let firstError: string | null = null
    for (const entry of list) {
      try {
        await deleteSession(entry.summary.id)
        removed.push(entry.summary.id)
      } catch (error) {
        if (firstError === null) firstError = errorMessage(error)
      }
    }
    if (removed.length > 0) onDeleted(removed)
    if (firstError !== null) {
      toast(
        removed.length > 0
          ? t('archived.deletedSome', {
              done: removed.length,
              total: list.length,
              error: firstError,
            })
          : firstError,
      )
    } else if (list.length === 1) {
      toast(t('archived.deleted'))
    } else {
      toast(t('archived.deletedCount', { count: removed.length }))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn('gap-3.5 px-5.5', CONFIRM)}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {several
              ? t('archived.deleteManyTitle', { count: shown.length })
              : t('archived.deleteOneTitle', { title: first?.title ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-small text-secondary">
            {several
              ? t('archived.deleteManyBody')
              : subTotal > 0
                ? t('archived.deleteOneBodyWithSubs', { count: subTotal })
                : t('archived.deleteOneBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {several && (
          <div
            className="k-ar-dlg-list"
            data-scrollable={shown.length > DELETE_LIST_CAP || undefined}
          >
            {shown.map((entry) => (
              <div key={entry.summary.id} className="k-ar-dlg-row">
                <AgentMark agent={entry.agentId} size={15} hostId={hostId} />
                <span className="k-ar-dlg-row__t" title={entry.title}>
                  {entry.title}
                </span>
                {entry.subSessionCount > 0 && (
                  <span className="k-ar-dlg-row__subs k-num">
                    {t('archived.subSessions', { count: entry.subSessionCount })}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <AlertDialogFooter className="pt-1">
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
            {several
              ? t('archived.deleteManyConfirm', { count: shown.length })
              : t('archived.deleteOneConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
