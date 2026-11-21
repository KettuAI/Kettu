import { useMemo, useState, type KeyboardEvent } from 'react'
import { Add01Icon, ArrowRight01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project, SessionSummary } from '@shared/agent-host'
import { newSession } from '@renderer/app/actions'
import { retryHostState } from '@renderer/app/bootstrap'
import { FolderClosedMark } from '@renderer/components/affect/app-shell'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostSwitchBar } from '@renderer/features/account/host-switch'
import { Glyph } from '@renderer/features/shell/glyph'
import { NO_PROJECT_ICON } from '@renderer/features/shell/no-project-icon'
import { UpdateCardView } from '@renderer/features/updates/update-card'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { isAway, shownHosts, useOtherHost, useOtherHosts } from '@renderer/stores/hosts'
import {
  noProjectKey,
  noProjectPinned,
  pinnedFolders,
  useProjectsStore,
} from '@renderer/stores/projects'
import {
  byActivity,
  byPin,
  hostGroup,
  hostOfSession,
  inPinnedTree,
  keepSameNodes,
  noProjectGroup,
  pinnedTree,
  sessionTree,
  sidebarRows,
  sidebarTabStop,
  type SessionNode,
  type SidebarRow,
  type SidebarTabStop,
  listedOrigin,
  useSessionsStore,
} from '@renderer/stores/sessions'
import { listedTasks, pinnedTasks, useTasksStore } from '@renderer/stores/tasks'
import {
  openSettings,
  PINNED_GROUP,
  showAllRows,
  THIS_COMPUTER,
  useViewStore,
} from '@renderer/stores/view'
import { StarCard } from '@renderer/features/github-star/star-prompts'
import { projectNameHints } from '@renderer/features/session/project-names'
import { AddProjectButton } from './add-project'
import { HostEmpty, HostHeading, NeedsYouGroup } from './host-groups'
import { useHostLabel } from './host-label'
import { ImportSessionsDialog } from './import-sessions'
import { InsecureCard } from './insecure-card'
import { signInLabel, useNotices } from './notices'
import { NoProjectMenuItems, ProjectMenuItems } from './project-menu'
import { RemoveProjectDialog } from './remove-project'
import { GroupRenameHints } from './rename-hints'
import { RenameScope } from './rename-scope'
import { limitRows, rowInSight, ROWS_SHOWN } from './row-limit'
import { RowEnd } from './session-indicator'
import { SessionRow } from './session-row'
import { SortableGroup, SortableList } from './sortable-list'
import { TaskRow } from './task-row'

/**
 * The sidebar's list under its menu, in App Shell's look: Pinned, then No project and the projects
 * as folders holding their sessions; with other hosts, Needs you and each host's projects
 * under its heading.
 */
export function SidebarList() {
  const { t } = useTranslation(['sidebar', 'common'])
  const projects = useProjectsStore((s) => s.projects)
  const noProjects = useProjectsStore((s) => s.noProjects)
  const projectsLoaded = useProjectsStore((s) => s.loaded)
  const sessionsLoaded = useSessionsStore((s) => s.loaded)
  const loaded = projectsLoaded && sessionsLoaded
  const loadError = useProjectsStore((s) => s.error)
  const sessionsError = useSessionsStore((s) => s.error)
  // Every project stays listed, with sessions or without, until it is removed from its menu; the
  // list follows its Tab stop, and each group follows its own sessions.
  const tasks = useTasksStore((s) => s.summaries)
  const main = useViewStore((s) => s.main)
  const collapsedProjects = useViewStore((s) => s.collapsedProjects)
  const expandedParents = useViewStore((s) => s.expandedParents)
  const others = useOtherHosts()
  const hostFilter = useViewStore((s) => s.hostFilter)
  const hostOrder = useViewStore((s) => s.hostOrder)
  // With other hosts, the list groups by host; with none, it is as it always was.
  const hosts = useMemo(
    () => (others.length > 0 ? shownHosts(others, hostFilter, hostOrder) : null),
    [others, hostFilter, hostOrder],
  )
  const away = useMemo(
    () => others.filter((host) => isAway(host.connection)).map((host) => host.id),
    [others],
  )
  const scratch = useHasNoProjectSessions(null)
  // The list has one Tab stop, chosen from the store so a hidden shown row leaves it to a header.
  const stopKey = useSessionsStore((s) =>
    tabStopKey(
      sidebarTabStop(
        { main, collapsedProjects, expandedParents, hosts, away },
        s.byId,
        projects,
        tasks,
        noProjects,
      ),
    ),
  )
  const stop = useMemo(() => tabStopOf(stopKey), [stopKey])
  // One dialog serves every project; it mounts the first time a project asks for it.
  const [importing, setImporting] = useState<{ project: Project; open: boolean } | null>(null)
  const importSessions = (project: Project) => setImporting({ project, open: true })

  return (
    <div className="kettu-side-list" role="presentation" onKeyDown={moveRowFocus}>
      <HostSwitchBar />
      <div
        role="group"
        aria-label={t('nav.sessions')}
        className={cn(
          'flex flex-col',
          loaded &&
            'motion-safe:animate-in motion-safe:fade-in motion-safe:animation-duration-(--duration-base)',
        )}
      >
        {!loaded && (loadError || sessionsError) ? (
          <div className="ui-as-side__empty mt-4 flex flex-col items-start gap-2">
            <p>{loadError ? t('nav.unavailable') : t('nav.sessionsUnavailable')}</p>
            <Button variant="outline" size="xs" onClick={() => void retryHostState()}>
              {t('common:actions.retry')}
            </Button>
          </div>
        ) : !loaded ? (
          // A group's label and its rows at their real sizes, so nothing moves as they arrive.
          <div className="ui-as-side__group">
            <span className="ui-as-side__label">
              <Skeleton className="h-3 w-16" />
            </span>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex h-[30px] items-center gap-2 px-1.5">
                <Skeleton className="size-4 rounded-sm" />
                <Skeleton className="h-3" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
              </div>
            ))}
          </div>
        ) : hosts ? (
          <>
            <NeedsYouGroup hosts={hosts} away={away} />
            <PinnedGroup
              projects={projects}
              stop={stop}
              hosts={hosts}
              away={away}
              onImport={importSessions}
            />
            <SortableList
              className="kettu-side-hosts"
              onMove={(from, to) => moveHost(hosts, from, to)}
              onPress={toggleGroup}
            >
              {hosts.map((hostId, index) => (
                <HostSection
                  key={hostId ?? THIS_COMPUTER}
                  hostId={hostId}
                  index={index}
                  movable={hosts.length > 1}
                  projects={projects}
                  stop={stop}
                  onImport={importSessions}
                />
              ))}
            </SortableList>
          </>
        ) : (
          <>
            <PinnedGroup projects={projects} stop={stop} onImport={importSessions} />
            <div className="ui-as-side__group" role="group" aria-label={t('nav.projects')}>
              <div className="ui-as-side__label kettu-projects-label">
                <span>{t('nav.projects')}</span>
                <AddProjectButton />
              </div>
              {projects.length === 0 && !scratch && (
                <span className="ui-as-side__empty">{t('nav.empty')}</span>
              )}
              {!noProjectPinned(noProjects, null) && (
                <ProjectGroup project={null} stop={stop} onImport={importSessions} />
              )}
              <ProjectList projects={projects} stop={stop} onImport={importSessions} />
            </div>
          </>
        )}
      </div>
      {importing && (
        <ImportSessionsDialog
          project={importing.project}
          open={importing.open}
          onOpenChange={(open) => setImporting({ ...importing, open })}
        />
      )}
    </div>
  )
}

/** Whether `hostId` has a session started with No project that the list shows. */
function useHasNoProjectSessions(hostId: string | null): boolean {
  return useSessionsStore((s) => noProjectHosts(Object.values(s.byId), [hostId]).length > 0)
}

/** Those of `hosts` with a session started with No project that the list shows. */
function noProjectHosts(
  summaries: readonly SessionSummary[],
  hosts: readonly (string | null)[],
): (string | null)[] {
  return hosts.filter((hostId) =>
    summaries.some(
      (x) => x.scratch && listedOrigin(x) && !x.archivedAt && hostOfSession(x) === hostId,
    ),
  )
}

/** `hosts` with the one at `from` moved to `to`, kept as this window's order. */
function moveHost(hosts: readonly (string | null)[], from: number, to: number): void {
  const order = hosts.map((hostId) => hostId ?? THIS_COMPUTER)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved!)
  useViewStore.setState({ hostOrder: order })
}

/**
 * A host's projects outside Pinned, in the order it keeps; a host that keeps one lets them be
 * dragged within its list, and an older one does not.
 */
function ProjectList({
  projects,
  stop,
  onImport,
  hostId = null,
  away = false,
}: {
  projects: readonly Project[]
  stop: SidebarTabStop | null
  onImport: (project: Project) => void
  hostId?: string | null
  away?: boolean
}) {
  const shown = projects.filter((project) => project.pinnedAt == null)
  const movable = !away && shown.length > 1 && shown.every((p) => p.order !== undefined)
  const move = (from: number, to: number) => {
    const order = shown.map((project) => project.path)
    const [path] = order.splice(from, 1)
    order.splice(to, 0, path!)
    useProjectsStore
      .getState()
      .move(path!, order[to + 1] ?? null)
      .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
  }
  return (
    <SortableList onMove={move} onPress={toggleGroup}>
      {shown.map((project, index) => (
        <SortableGroup key={project.path} id={project.path} index={index} disabled={!movable}>
          {(handleRef) => (
            <ProjectGroup
              project={project}
              stop={stop}
              onImport={onImport}
              hostId={hostId}
              away={away}
              handleRef={handleRef}
            />
          )}
        </SortableGroup>
      ))}
    </SortableList>
  )
}

/** A host's heading, its No project group and its projects' folders. */
function HostSection({
  hostId,
  index,
  movable,
  projects,
  stop,
  onImport,
}: {
  hostId: string | null
  index: number
  movable: boolean
  projects: readonly Project[]
  stop: SidebarTabStop | null
  onImport: (project: Project) => void
}) {
  const away = isAway(useOtherHost(hostId)?.connection ?? null)
  const own = projects.filter((project) => hostOfPath(project.path) === hostId)
  const scratch = useHasNoProjectSessions(hostId)
  const pinned = useProjectsStore((s) => noProjectPinned(s.noProjects, hostId))
  const key = hostGroup(hostId)
  const open = useViewStore((s) => !s.collapsedProjects[key])
  const label = useHostLabel(hostId)
  return (
    <SortableGroup
      id={key}
      index={index}
      disabled={!movable}
      as="section"
      label={label}
      className="ui-as-side__group"
    >
      {(handleRef) => (
        <>
          <div className="kettu-host-head">
            <HostHeading
              hostId={hostId}
              open={open}
              stop={stop}
              onToggle={() => toggleGroup(key)}
              handleRef={handleRef}
            />
            {!away && <AddProjectButton hostId={hostId} />}
          </div>
          {open && (
            <>
              {!pinned && (
                <ProjectGroup
                  project={null}
                  stop={stop}
                  onImport={onImport}
                  hostId={hostId}
                  away={away}
                />
              )}
              <ProjectList
                projects={own}
                stop={stop}
                onImport={onImport}
                hostId={hostId}
                away={away}
              />
              {own.length === 0 && !scratch && <HostEmpty />}
            </>
          )}
        </>
      )}
    </SortableGroup>
  )
}

/**
 * A project's folder and its sessions and tasks, the latest first, or with a null project the
 * sessions started with No project on `hostId`, if any. An offline host's offer nothing to start.
 */
function ProjectGroup({
  project,
  stop,
  onImport,
  hostId = null,
  away = false,
  showHost = false,
  handleRef,
}: {
  project: Project | null
  stop: SidebarTabStop | null
  onImport: (project: Project) => void
  hostId?: string | null
  away?: boolean
  showHost?: boolean
  /** Where a drag picks the folder up, when its list can be reordered. */
  handleRef?: (element: Element | null) => void
}) {
  const key = project?.path ?? noProjectGroup(hostId)
  const { t } = useTranslation('sidebar')
  const name = project?.name ?? t('project.noProject')
  // What tells the project from another of the same name, as New session's project menu shows it.
  const hint = useProjectsStore((s) =>
    project ? projectNameHints(s.projects.map((p) => p.path)).get(project.path) : undefined,
  )
  const hostName = useHostLabel(hostId)
  const open = useViewStore((s) => !s.collapsedProjects[key])
  const allShown = useViewStore((s) => !!s.allRowsShown[key])
  const shownId = useViewStore((s) =>
    s.main.kind === 'session' ? s.main.sessionId : s.main.kind === 'task' ? s.main.taskId : null,
  )
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Null until Remove project is first asked for, so the dialog mounts only then.
  const [removing, setRemoving] = useState<boolean | null>(null)
  const noProject = useProjectsStore((s) =>
    project ? undefined : s.noProjects[noProjectKey(hostId)],
  )
  const summaries = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter((x) =>
        project ? x.projectPath === project.path : x.scratch && hostOfSession(x) === hostId,
      ),
    ),
  )
  const projectPath = project?.path ?? null
  const tree = useKeptNodes(
    useMemo(
      () => sessionTree(Object.fromEntries(summaries.map((x) => [x.id, x])), projectPath, hostId),
      [summaries, projectPath, hostId],
    ),
  )
  const tasks = useTasksStore(
    useShallow((s) => (project ? listedTasks(s.summaries, project.path) : [])),
  )
  const rows = useMemo(() => sidebarRows(tree, tasks, byActivity), [tree, tasks])
  if (!project && tree.length === 0) return null
  const limited = limitRows(rows, allShown, (row) => rowInSight(row, shownId))
  // Importing reads the agents' own lists, which only this computer's do.
  const local = hostId === null
  // A host that cannot pin a group leaves its pin out.
  const canPin = project ? project.pinnedAt !== undefined : noProject !== undefined
  const hasMenu = local || canPin

  const toggle = () => toggleGroup(key)
  const groupStop = stop?.kind === 'group' && stop.key === key
  const tabStopId = stop?.kind === 'session' ? stop.id : null
  const newLabel = project ? t('project.newSessionIn', { name }) : t('project.newSessionNoProject')
  // New session starts No project sessions on this computer only.
  const canStart = !project?.missing && !away && (!!project || local)

  const row = (
    <button
      ref={handleRef}
      type="button"
      data-sidebar-row=""
      data-sidebar-group={key}
      tabIndex={groupStop ? 0 : -1}
      aria-expanded={open}
      onClick={(event) => {
        // A drag that ends on the row clicks it; its list folds it then, if it was a press.
        if (!event.defaultPrevented) toggle()
      }}
      onKeyDown={(event) => {
        // A row being dragged from the keyboard moves with the arrows instead.
        if (event.defaultPrevented) return
        // The context menu key opens the More menu, the row's menu for the keyboard.
        if (hasMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault()
          setMoreOpen(true)
        } else if (event.key === 'ArrowRight' && !open) toggle()
        else if (event.key === 'ArrowLeft' && open) toggle()
      }}
      className={cn(
        'ui-as-side__item ui-as-chat-folder',
        (project?.missing || away) && 'text-(--faint)!',
      )}
    >
      {!project ? <Glyph icon={NO_PROJECT_ICON} /> : open ? <FolderMark /> : <FolderClosedMark />}
      <span className="ui-as-side__text">
        {name}
        {hint && <span className="ml-1.5 text-(--faint)">{hint}</span>}
      </span>
      {project?.missing && (
        <span className="shrink-0 text-[12px] text-(--faint)">{t('project.missing')}</span>
      )}
      {/* On hover a small arrow after the name: right when closed, down when open. */}
      <span className="ui-as-chat-folder__arrow" aria-hidden>
        <Glyph icon={ArrowRight01Icon} size={13} />
      </span>
      <RowEnd>
        {showHost && (
          <span className="max-w-24 truncate text-[12px] font-normal text-(--faint)">
            {hostName}
          </span>
        )}
      </RowEnd>
    </button>
  )
  const tooltip = project ? (
    <TooltipContent side="right" className="max-w-sm font-mono break-all">
      {hostPath(project.path)}
    </TooltipContent>
  ) : (
    <TooltipContent side="right">{t('project.noProjectTooltip')}</TooltipContent>
  )
  const pin = async (pinned: boolean) => {
    try {
      await hostAt(hostId, 'projects.pin', { path: projectPath, pinned })
      const group = pinned ? PINNED_GROUP : hostGroup(hostId)
      if (useViewStore.getState().collapsedProjects[group]) toggleGroup(group)
      // The row moved between groups, so it is a new element; focus follows it there.
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return
        document.querySelector<HTMLElement>(`[data-sidebar-group="${CSS.escape(key)}"]`)?.focus()
      })
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    }
  }
  const menuItems = !hasMenu ? null : project ? (
    <ProjectMenuItems
      project={project}
      pinDisabled={away}
      onPin={pin}
      onImport={() => onImport(project)}
      onRemove={() => setRemoving(true)}
    />
  ) : (
    <NoProjectMenuItems
      local={local}
      pinned={noProject ? noProject.pinnedAt !== null : undefined}
      pinDisabled={away}
      onPin={pin}
    />
  )

  return (
    <>
      <div className="ui-as-chat-folder-row" data-menu={moreOpen || menuOpen || undefined}>
        {hasMenu ? (
          <ContextMenu onOpenChange={setMenuOpen}>
            {/* A trigger's render must take its props, so the tooltip Root wraps the menu trigger. */}
            <Tooltip>
              <TooltipTrigger render={<ContextMenuTrigger render={row} />} delay={700} />
              {tooltip}
            </Tooltip>
            <ContextMenuContent>{menuItems}</ContextMenuContent>
          </ContextMenu>
        ) : (
          <Tooltip>
            <TooltipTrigger render={row} delay={700} />
            {tooltip}
          </Tooltip>
        )}
        <span className="ui-as-chat-row__tools">
          {hasMenu && (
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('row.moreFor', { title: name })}
                    title={t('row.more')}
                    className="ui-as-chat-row__tool"
                  />
                }
              >
                <Glyph icon={MoreHorizontalIcon} size={15} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">{menuItems}</DropdownMenuContent>
            </DropdownMenu>
          )}
          {canStart && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={newLabel}
              title={newLabel}
              onClick={() => newSession(projectPath, !project)}
              className="ui-as-chat-row__tool"
            >
              <Glyph icon={Add01Icon} size={14} />
            </button>
          )}
        </span>
      </div>
      {open && rows.length > 0 && (
        <ul className="ui-as-chat-folder__chats">
          <RenameScope value={key}>
            <AnimatePresence initial={false}>
              {limited.rows.map((row) => (
                <GroupRow key={row.id} row={row} tabStopId={tabStopId} indent />
              ))}
            </AnimatePresence>
          </RenameScope>
          {(limited.hidden > 0 || allShown) && rows.length > ROWS_SHOWN && (
            <li className="flex">
              <button
                type="button"
                data-sidebar-row=""
                tabIndex={-1}
                onClick={() => showAllRows(key, !allShown)}
                className="ui-as-side__item kettu-side-more"
              >
                <span className="ui-as-side__text">
                  {allShown ? t('list.showLess') : t('list.showMore', { count: limited.hidden })}
                </span>
              </button>
            </li>
          )}
          <GroupRenameHints scope={key} />
        </ul>
      )}
      {project && removing !== null && (
        <RemoveProjectDialog project={project} open={removing} onOpenChange={setRemoving} />
      )}
    </>
  )
}

/** A session's row or a task's, as a group lists it. */
function GroupRow({
  row,
  tabStopId,
  indent,
  showHost,
}: {
  row: SidebarRow
  tabStopId: string | null
  indent?: boolean
  showHost?: boolean
}) {
  return row.kind === 'session' ? (
    <SessionRow node={row.node} tabStopId={tabStopId} indent={indent} showHost={showHost} />
  ) : (
    <TaskRow
      task={row.task}
      origin={row.origin}
      tabStopId={tabStopId}
      indent={indent}
      showHost={showHost}
    />
  )
}

/** The Tab stop as a string, which a selector can compare. */
function tabStopKey(stop: SidebarTabStop | null): string {
  return stop ? `${stop.kind}:${stop.kind === 'session' ? stop.id : stop.key}` : ''
}

function tabStopOf(key: string): SidebarTabStop | null {
  const at = key.indexOf(':')
  if (at < 0) return null
  const value = key.slice(at + 1)
  return key.slice(0, at) === 'session'
    ? { kind: 'session', id: value }
    : { kind: 'group', key: value }
}

/** `next`, with the nodes of rows that did not change kept from before, so those rows skip a render. */
function useKeptNodes(next: SessionNode[]): SessionNode[] {
  const [kept, setKept] = useState({ from: next, nodes: next })
  if (kept.from === next) return kept.nodes
  const nodes = keepSameNodes(kept.nodes, next)
  setKept({ from: next, nodes })
  return nodes
}

function toggleGroup(key: string): void {
  useViewStore.setState((s) => {
    const collapsedProjects = { ...s.collapsedProjects }
    if (collapsedProjects[key]) delete collapsedProjects[key]
    else collapsedProjects[key] = true
    return { collapsedProjects }
  })
}

/**
 * The pinned projects and No project groups, then the pinned sessions and tasks, of the hosts
 * shown. Its title folds them.
 */
function PinnedGroup({
  projects,
  stop,
  hosts,
  away,
  onImport,
}: {
  projects: readonly Project[]
  stop: SidebarTabStop | null
  hosts?: readonly (string | null)[]
  away?: readonly string[]
  onImport: (project: Project) => void
}) {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => !s.collapsedProjects[PINNED_GROUP])
  const summaries = useSessionsStore(
    useShallow((s) => Object.values(s.byId).filter((x) => inPinnedTree(s.byId, x))),
  )
  const tree = useKeptNodes(
    useMemo(
      () =>
        pinnedTree(Object.fromEntries(summaries.map((x) => [x.id, x]))).filter(
          (node) => !hosts || hosts.includes(hostOfSession(node.summary)),
        ),
      [summaries, hosts],
    ),
  )
  const tasks = useTasksStore(
    useShallow((s) =>
      pinnedTasks(s.summaries).filter(
        (task) => !hosts || hosts.includes(hostOfPath(task.projectPath)),
      ),
    ),
  )
  const rows = useMemo(() => sidebarRows(tree, tasks, byPin), [tree, tasks])
  const noProjects = useProjectsStore((s) => s.noProjects)
  // A No project group shows only while it has sessions, pinned or not.
  const scratchHosts = useSessionsStore(
    useShallow((s) => noProjectHosts(Object.values(s.byId), hosts ?? [null])),
  )
  const folders = useMemo(
    () =>
      pinnedFolders(projects, noProjects, hosts).filter(
        (folder) => folder.project || scratchHosts.includes(folder.hostId),
      ),
    [projects, noProjects, hosts, scratchHosts],
  )
  if (rows.length === 0 && folders.length === 0) return null
  const toggle = () => toggleGroup(PINNED_GROUP)
  const tabStopId = stop?.kind === 'session' ? stop.id : null
  return (
    <div
      className="ui-as-side__group ui-as-chat-pinned"
      role="group"
      aria-label={t('pinned.label')}
    >
      <button
        type="button"
        data-sidebar-row=""
        tabIndex={stop?.kind === 'group' && stop.key === PINNED_GROUP ? 0 : -1}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !open) toggle()
          else if (event.key === 'ArrowLeft' && open) toggle()
        }}
        className="ui-as-side__label kettu-side-label"
      >
        {t('pinned.label')}
        <span className="kettu-side-label__arrow" aria-hidden>
          <Glyph icon={ArrowRight01Icon} size={12} />
        </span>
      </button>
      {open && (
        <>
          {folders.map(({ project, hostId }) => (
            <ProjectGroup
              key={project?.path ?? noProjectGroup(hostId)}
              project={project}
              stop={stop}
              onImport={onImport}
              hostId={hostId}
              away={hostId !== null && away?.includes(hostId)}
              showHost={!!hosts}
            />
          ))}
          <ul className="flex flex-col">
            <RenameScope value={PINNED_GROUP}>
              <AnimatePresence initial={false}>
                {rows.map((row) => (
                  <GroupRow key={row.id} row={row} tabStopId={tabStopId} showHost={!!hosts} />
                ))}
              </AnimatePresence>
            </RenameScope>
            <GroupRenameHints scope={PINNED_GROUP} />
          </ul>
        </>
      )}
    </div>
  )
}

/** The list is one Tab stop; the arrow keys move between rows. */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>): void {
  // A row being renamed is a text field, which keeps its own Home and End; a row being dragged
  // from the keyboard takes the arrows.
  if (event.target instanceof HTMLInputElement || event.defaultPrevented) return
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  )
    return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-row]'))
  if (!rows.length) return
  const at = rows.indexOf(document.activeElement as HTMLElement)
  let next = at
  if (event.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(rows.length - 1, at + 1)
  if (event.key === 'ArrowUp') next = at < 0 ? rows.length - 1 : Math.max(0, at - 1)
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = rows.length - 1
  event.preventDefault()
  rows[next]?.focus()
}

/**
 * The cards over the account row: the web client's insecure page, agents that need sign-in and
 * one update card for Kettu and the harnesses, never stacked.
 */
export function SidebarNotices() {
  const { signIn } = useNotices()
  const { card, items, batch } = useUpdates()
  return (
    <>
      {isWeb && !window.isSecureContext && <InsecureCard />}
      {signIn.length > 0 && <SignInCard names={signIn} />}
      {card && <UpdateCardView card={card} items={items} batch={batch} />}
      <StarCard blocked={(isWeb && !window.isSecureContext) || signIn.length > 0 || !!card} />
    </>
  )
}

/** An agent needs sign-in: something to do, so it takes the warning color, and it cannot be dismissed. */
function SignInCard({ names }: { names: string[] }) {
  const { t } = useTranslation('sidebar')
  const label = signInLabel(names)
  return (
    <NoticeCard
      icon={<span aria-hidden className="size-1.5 rounded-full bg-current text-warning" />}
      text={label}
      label={label}
      detail={t('footer.signInDetail')}
      onOpen={() => openSettings('agents')}
    />
  )
}
