import { useMemo, useState, type KeyboardEvent } from 'react'
import { Add01Icon, ArrowRight01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostSwitchBar } from '@renderer/features/account/host-switch'
import { Glyph } from '@renderer/features/shell/glyph'
import { UpdateCardView } from '@renderer/features/updates/update-card'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { isAway, shownHosts, useOtherHost, useOtherHosts } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  hostGroup,
  hostOfSession,
  inPinnedTree,
  noProjectGroup,
  pinnedTree,
  sessionTree,
  sidebarTabStop,
  type SidebarTabStop,
  useSessionsStore,
} from '@renderer/stores/sessions'
import { openSettings, PINNED_GROUP, showAllRows, useViewStore } from '@renderer/stores/view'
import { HostEmpty, HostHeading, NeedsYouGroup } from './host-groups'
import { useHostLabel } from './host-label'
import { ImportSessionsDialog } from './import-sessions'
import { InsecureCard } from './insecure-card'
import { signInLabel, useNotices } from './notices'
import { ProjectMenuItems } from './project-menu'
import { visibleProjects } from './project-group'
import { GroupRenameHints } from './rename-hints'
import { RenameScope } from './rename-scope'
import { keepInSight, limitRows, ROWS_SHOWN } from './row-limit'
import { SessionRow } from './session-row'

/**
 * The sidebar's list under its menu, in App Shell's look: Pinned, then the projects as folders
 * holding their sessions, then No project; with other hosts, Needs you and each host's projects
 * under its heading.
 */
export function SidebarList() {
  const { t } = useTranslation(['sidebar', 'common'])
  const projects = useProjectsStore((s) => s.projects)
  const projectsLoaded = useProjectsStore((s) => s.loaded)
  const sessionsLoaded = useSessionsStore((s) => s.loaded)
  const loaded = projectsLoaded && sessionsLoaded
  const loadError = useProjectsStore((s) => s.error)
  const sessionsError = useSessionsStore((s) => s.error)
  const sessionsById = useSessionsStore((s) => s.byId)
  const shownProjects = visibleProjects(projects, sessionsById)
  const main = useViewStore((s) => s.main)
  const collapsedProjects = useViewStore((s) => s.collapsedProjects)
  const expandedParents = useViewStore((s) => s.expandedParents)
  const others = useOtherHosts()
  const hostFilter = useViewStore((s) => s.hostFilter)
  // With other hosts, the list groups by host; with none, it is as it always was.
  const hosts = useMemo(
    () => (others.length > 0 ? shownHosts(others, hostFilter) : null),
    [others, hostFilter],
  )
  const away = useMemo(
    () => others.filter((host) => isAway(host.connection)).map((host) => host.id),
    [others],
  )
  // The list has one Tab stop, chosen from the store so a hidden shown row leaves it to a header.
  const stop = sidebarTabStop(
    { main, collapsedProjects, expandedParents, hosts, away },
    sessionsById,
    shownProjects,
  )
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
            <PinnedGroup stop={stop} hosts={hosts} />
            {hosts.map((hostId) => (
              <HostSection
                key={hostId ?? 'this-computer'}
                hostId={hostId}
                projects={shownProjects}
                stop={stop}
                onImport={importSessions}
              />
            ))}
          </>
        ) : (
          <>
            <PinnedGroup stop={stop} />
            <div className="ui-as-side__group" role="group" aria-label={t('nav.projects')}>
              <span className="ui-as-side__label">{t('nav.projects')}</span>
              {shownProjects.length === 0 && (
                <span className="ui-as-side__empty">{t('nav.empty')}</span>
              )}
              {shownProjects.map((project) => (
                <ProjectGroup
                  key={project.path}
                  project={project}
                  stop={stop}
                  onImport={importSessions}
                />
              ))}
              <ProjectGroup project={null} stop={stop} onImport={importSessions} />
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

/** A host's heading, its projects' folders and its No project folder. */
function HostSection({
  hostId,
  projects,
  stop,
  onImport,
}: {
  hostId: string | null
  projects: readonly Project[]
  stop: SidebarTabStop | null
  onImport: (project: Project) => void
}) {
  const away = isAway(useOtherHost(hostId)?.connection ?? null)
  const own = projects.filter((project) => hostOfPath(project.path) === hostId)
  const scratch = useSessionsStore((s) =>
    Object.values(s.byId).some(
      (x) => x.scratch && x.origin !== 'routine' && !x.archivedAt && hostOfSession(x) === hostId,
    ),
  )
  const key = hostGroup(hostId)
  const open = useViewStore((s) => !s.collapsedProjects[key])
  return (
    <section aria-label={useHostLabel(hostId)} className="ui-as-side__group">
      <HostHeading hostId={hostId} open={open} stop={stop} onToggle={() => toggleGroup(key)} />
      {open && (
        <>
          {own.map((project) => (
            <ProjectGroup
              key={project.path}
              project={project}
              stop={stop}
              onImport={onImport}
              hostId={hostId}
              away={away}
            />
          ))}
          <ProjectGroup
            project={null}
            stop={stop}
            onImport={onImport}
            hostId={hostId}
            away={away}
          />
          {own.length === 0 && !scratch && <HostEmpty />}
        </>
      )}
    </section>
  )
}

/**
 * A project's folder and its sessions, or with a null project those started with No project on
 * `hostId`, if any. An offline host's offer nothing to start.
 */
function ProjectGroup({
  project,
  stop,
  onImport,
  hostId = null,
  away = false,
}: {
  project: Project | null
  stop: SidebarTabStop | null
  onImport: (project: Project) => void
  hostId?: string | null
  away?: boolean
}) {
  const key = project?.path ?? noProjectGroup(hostId)
  const { t } = useTranslation('sidebar')
  const name = project?.name ?? t('project.noProject')
  const open = useViewStore((s) => !s.collapsedProjects[key])
  const allShown = useViewStore((s) => !!s.allRowsShown[key])
  const shownId = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const summaries = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter((x) =>
        project ? x.projectPath === project.path : x.scratch && hostOfSession(x) === hostId,
      ),
    ),
  )
  const projectPath = project?.path ?? null
  const tree = useMemo(
    () => sessionTree(Object.fromEntries(summaries.map((x) => [x.id, x])), projectPath, hostId),
    [summaries, projectPath, hostId],
  )
  if (!project && tree.length === 0) return null
  const limited = limitRows(tree, allShown, (node) => keepInSight(node, shownId))
  // Importing reads the agents' own lists, which only this computer's do.
  const local = hostId === null

  const toggle = () => toggleGroup(key)
  const groupStop = stop?.kind === 'group' && stop.key === key
  const tabStopId = stop?.kind === 'session' ? stop.id : null
  const newLabel = project ? t('project.newSessionIn', { name }) : t('project.newSessionNoProject')
  // New session starts No project sessions on this computer only.
  const canStart = !project?.missing && !away && (!!project || local)

  const row = (
    <button
      type="button"
      data-sidebar-row=""
      tabIndex={groupStop ? 0 : -1}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={(event) => {
        // The context menu key opens the More menu, the row's menu for the keyboard.
        if (project && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
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
      {open ? <FolderMark /> : <FolderClosedMark />}
      <span className="ui-as-side__text">{name}</span>
      {project?.missing && (
        <span className="shrink-0 text-[12px] text-(--faint)">{t('project.missing')}</span>
      )}
      {/* On hover a small arrow after the name: right when closed, down when open. */}
      <span className="ui-as-chat-folder__arrow" aria-hidden>
        <Glyph icon={ArrowRight01Icon} size={13} />
      </span>
    </button>
  )
  const tooltip = project ? (
    <TooltipContent side="right" className="max-w-sm font-mono break-all">
      {hostPath(project.path)}
    </TooltipContent>
  ) : (
    <TooltipContent side="right">{t('project.noProjectTooltip')}</TooltipContent>
  )
  const menuItems = project && local && (
    <ProjectMenuItems project={project} onImport={() => onImport(project)} />
  )

  return (
    <>
      <div className="ui-as-chat-folder-row" data-menu={moreOpen || menuOpen || undefined}>
        {project && local ? (
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
          {project && local && (
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
      {open && tree.length > 0 && (
        <ul className="ui-as-chat-folder__chats">
          <RenameScope value={key}>
            <AnimatePresence initial={false}>
              {limited.rows.map((node) => (
                <SessionRow key={node.summary.id} node={node} tabStopId={tabStopId} indent />
              ))}
            </AnimatePresence>
          </RenameScope>
          {(limited.hidden > 0 || allShown) && tree.length > ROWS_SHOWN && (
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
    </>
  )
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
 * The pinned sessions across the projects, above them, while there are any; with other hosts, of
 * the hosts shown, each row naming its host. Its title folds it.
 */
function PinnedGroup({
  stop,
  hosts,
}: {
  stop: SidebarTabStop | null
  hosts?: readonly (string | null)[]
}) {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => !s.collapsedProjects[PINNED_GROUP])
  const summaries = useSessionsStore(
    useShallow((s) => Object.values(s.byId).filter((x) => inPinnedTree(s.byId, x))),
  )
  const tree = useMemo(
    () =>
      pinnedTree(Object.fromEntries(summaries.map((x) => [x.id, x]))).filter(
        (node) => !hosts || hosts.includes(hostOfSession(node.summary)),
      ),
    [summaries, hosts],
  )
  if (tree.length === 0) return null
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
        <ul className="flex flex-col">
          <RenameScope value={PINNED_GROUP}>
            <AnimatePresence initial={false}>
              {tree.map((node) => (
                <SessionRow
                  key={node.summary.id}
                  node={node}
                  tabStopId={tabStopId}
                  showHost={!!hosts}
                />
              ))}
            </AnimatePresence>
          </RenameScope>
          <GroupRenameHints scope={PINNED_GROUP} />
        </ul>
      )}
    </div>
  )
}

/** The list is one Tab stop; the arrow keys move between rows. */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>): void {
  // A row being renamed is a text field, which keeps its own Home and End.
  if (event.target instanceof HTMLInputElement) return
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
  const { card, items } = useUpdates()
  return (
    <>
      {isWeb && !window.isSecureContext && <InsecureCard />}
      {signIn.length > 0 && <SignInCard names={signIn} />}
      {card && <UpdateCardView card={card} items={items} />}
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
