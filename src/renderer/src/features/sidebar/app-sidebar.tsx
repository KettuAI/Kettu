import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  HistoryIcon,
  PlusIcon,
  ShapesIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, PlanLimit, Project } from '@shared/agent-host'
import type { RoutineView } from '@shared/routines'
import { newSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@renderer/components/ui/sidebar'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BackForward } from '@renderer/features/shell/back-forward'
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { strongestSignal, signalText } from '@renderer/features/routines/model'
import { RunningDot } from '@renderer/features/routines/run-mark'
import { dayOf } from '@renderer/features/usage/model'
import { limitLabel, tokens } from '@renderer/lib/format'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import {
  inPinnedTree,
  pinnedTree,
  sessionTree,
  sidebarTabStop,
  type SidebarTabStop,
  useSessionsStore,
} from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { loadToday, useUsageStore } from '@renderer/stores/usage'
import {
  NO_PROJECT_GROUP,
  openArtifacts,
  openRoutines,
  openUsage,
  PINNED_GROUP,
  useViewStore,
} from '@renderer/stores/view'
import { ImportSessionsDialog } from './import-sessions'
import { tightestLimit, USAGE_TONE_TEXT, usageTone } from './plan-usage'
import { visibleProjects } from './project-group'
import { SessionRow } from './session-row'
import { SidebarFooterContent } from './sidebar-footer'
import { costText } from './usage-row'

export function AppSidebar() {
  const { t } = useTranslation('sidebar')
  const projects = useProjectsStore((s) => s.projects)
  const projectsLoaded = useProjectsStore((s) => s.loaded)
  const sessionsLoaded = useSessionsStore((s) => s.loaded)
  const loaded = projectsLoaded && sessionsLoaded
  const loadError = useProjectsStore((s) => s.error)
  const sessionsById = useSessionsStore((s) => s.byId)
  const shownProjects = visibleProjects(projects, sessionsById)
  const main = useViewStore((s) => s.main)
  const collapsedProjects = useViewStore((s) => s.collapsedProjects)
  const expandedParents = useViewStore((s) => s.expandedParents)
  // The list has one Tab stop, chosen from the store so a hidden shown row leaves it to a header.
  const stop = sidebarTabStop(
    { main, collapsedProjects, expandedParents },
    sessionsById,
    shownProjects,
  )
  const drafting = useViewStore((s) => s.main.kind === 'new' && !s.settings.open)
  // The viewer opened from the page belongs to it.
  const artifactsShown = useViewStore(
    (s) =>
      !s.settings.open &&
      (s.main.kind === 'artifacts' ||
        (s.main.kind === 'artifact' && s.main.back.kind === 'artifacts')),
  )
  // One dialog serves every project; it mounts the first time a project asks for it.
  const [importing, setImporting] = useState<{ project: Project; open: boolean } | null>(null)
  const importSessions = (project: Project) => setImporting({ project, open: true })

  return (
    <Sidebar
      collapsible="none"
      role="navigation"
      className="w-full bg-transparent"
      aria-label={t('nav.label')}
    >
      {/* On macOS level with the top bar; elsewhere in the band. */}
      <div
        className={cn(
          'app-region-drag flex shrink-0 items-center pr-2.5 pl-5',
          isMac ? 'h-top-bar' : 'h-(--title-bar)',
        )}
      >
        {isMac && <span aria-hidden className="w-(--traffic-lights)" />}
        <BackForward className={cn(isMac && 'ml-2')} />
        {/* The window's drag region, 18 px of it at the sidebar's narrowest. */}
        <span className="flex-1" />
        <SidebarToggle />
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-0.5">
        <NavRow
          icon={<PlusIcon />}
          label={t('nav.newSession')}
          shortcut="Mod+N"
          current={drafting}
          onClick={() => newSession()}
        />
        <NavRow
          icon={<ShapesIcon />}
          label={t('nav.artifacts')}
          current={artifactsShown}
          onClick={openArtifacts}
        />
        <UsageNavRow />
        <RoutinesNavRow />
      </div>
      <SidebarContent className="scroll-fade-y gap-0 px-2 pt-1.5 pb-2" onKeyDown={moveRowFocus}>
        {/* No header row: projects are added with Mod+O, the File menu or New session. */}
        <SidebarGroup
          role="group"
          aria-label={t('nav.sessions')}
          className={cn(
            'gap-0.5 p-0',
            loaded &&
              'motion-safe:animate-in motion-safe:fade-in motion-safe:animation-duration-(--duration-base)',
          )}
        >
          {!loaded && loadError ? (
            <p className="mt-3.5 px-2.5 py-1 text-xs leading-normal text-secondary">
              {t('nav.unavailable')}
            </p>
          ) : !loaded ? (
            // A project's label and its rows at their real sizes, so nothing moves as they arrive.
            <>
              <div className="mt-3.5 flex h-[30px] items-center pl-2.5">
                <Skeleton className="h-3 w-20" />
              </div>
              <SidebarMenu className="gap-0.5">
                {[0, 1, 2, 3].map((i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon className="h-row gap-[9px] px-2.5" />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </>
          ) : (
            <>
              <PinnedGroup stop={stop} />
              {shownProjects.length === 0 ? (
                <p className="mt-3.5 px-2.5 py-1 text-xs leading-normal text-secondary">
                  {t('nav.empty')}
                </p>
              ) : (
                shownProjects.map((project) => (
                  <ProjectGroup
                    key={project.path}
                    project={project}
                    stop={stop}
                    onImport={importSessions}
                  />
                ))
              )}
              <ProjectGroup project={null} stop={stop} onImport={importSessions} />
            </>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-1.5 border-t p-2">
        <SidebarFooterContent />
      </SidebarFooter>
      {importing && (
        <ImportSessionsDialog
          project={importing.project}
          open={importing.open}
          onOpenChange={(open) => setImporting({ ...importing, open })}
        />
      )}
    </Sidebar>
  )
}

export function NavRow({
  icon,
  label,
  shortcut,
  current,
  onClick,
  extra,
  ariaLabel,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  current?: boolean
  onClick?: () => void
  extra?: React.ReactNode
  /** The row's name in words, when `extra` says more than its marks. */
  ariaLabel?: string
}) {
  const row = (
    <SidebarMenuButton
      size="row"
      isActive={current}
      onClick={onClick}
      aria-label={ariaLabel}
      className="[&_svg]:size-4"
    >
      <span className="contents text-secondary group-data-active/menu-button:text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {extra}
    </SidebarMenuButton>
  )
  // A shortcut shows in the row's tooltip, never as a hint on the row.
  if (!shortcut) return row
  return (
    <Tooltip>
      <TooltipTrigger render={row} delay={700} />
      <TooltipContent side="right">
        {label}
        <Kbd>{formatShortcut(shortcut)}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** The Routines row; its end shows the strongest signal among the routines' runs. */
function RoutinesNavRow() {
  const { t } = useTranslation('sidebar')
  const { t: tr } = useTranslation('routines')
  const routines = useRoutinesStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((routine): routine is RoutineView => !!routine),
    ),
  )
  const main = useViewStore((s) => s.main)
  const settingsOpen = useViewStore((s) => s.settings.open)
  const runSession = useSessionsStore((s) =>
    main.kind === 'session' ? s.byId[main.sessionId]?.origin === 'routine' : false,
  )
  const current =
    !settingsOpen && (main.kind === 'routines' || main.kind === 'routine' || runSession)
  const signal = strongestSignal(routines)
  const name = signal ? tr('signal.name', { signal: signalText(signal) }) : t('nav.routines')

  return (
    <NavRow
      icon={<CalendarClockIcon />}
      label={t('nav.routines')}
      current={current}
      onClick={openRoutines}
      ariaLabel={name}
      extra={signal ? <RoutineSignalMark signal={signal} /> : undefined}
    />
  )
}

/** The routines' strongest signal, as a session row draws its own; runs waiting are counted. */
function RoutineSignalMark({
  signal,
}: {
  signal: NonNullable<ReturnType<typeof strongestSignal>>
}) {
  if (signal.kind === 'waiting') {
    return (
      <span
        aria-hidden
        className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-attention px-[5px] text-meta font-semibold text-attention-foreground tabular"
      >
        {signal.count}
      </span>
    )
  }
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center">
      {signal.kind === 'failed' ? (
        <CircleAlertIcon className="size-3.5 text-danger" />
      ) : signal.kind === 'running' ? (
        <RunningDot />
      ) : (
        <span className="size-2 rounded-full bg-current text-tertiary" />
      )}
    </span>
  )
}

/** The Usage row; its end shows today's tokens, cost or plan limit, as Settings chooses. */
function UsageNavRow() {
  const { t } = useTranslation('usage')
  const current = useViewStore((s) => s.main.kind === 'usage' && !s.settings.open)
  const end = useSettingsStore((s) => s.settings.usage.sidebar)
  const extra =
    end === 'today' ? (
      <TodayTokens />
    ) : end === 'cost' ? (
      <TodayCost />
    ) : end === 'limit' ? (
      <TightestLimit />
    ) : undefined
  return (
    <NavRow
      icon={<ChartNoAxesColumnIcon />}
      label={t('nav.usage')}
      current={current}
      onClick={openUsage}
      extra={extra}
    />
  )
}

function TodayTokens() {
  const { t } = useTranslation('usage')
  const today = useUsageStore((s) => s.today)
  const day = dayOf(useNow())
  // A new day starts from nothing, whether or not a turn ends to say so.
  useEffect(() => void loadToday(), [day])
  // Quiet until there is something to count.
  if (!today) return null
  return (
    <span className="text-xs font-normal text-tertiary tabular-nums">
      <span aria-hidden>{tokens(today)}</span>
      <span className="sr-only">{t('nav.today', { tokens: tokens(today) })}</span>
    </span>
  )
}

function TodayCost() {
  const { t } = useTranslation('usage')
  const cost = useUsageStore((s) => s.todayCost)
  const day = dayOf(useNow())
  // A new day starts from nothing, whether or not a turn ends to say so.
  useEffect(() => void loadToday(), [day])
  const text = costText(cost)
  // Quiet until there is something to show.
  if (!text) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="text-xs font-normal text-tertiary tabular-nums" />}
        delay={700}
      >
        <span aria-hidden>{text}</span>
        <span className="sr-only">{t('nav.todayCost', { cost: text })}</span>
      </TooltipTrigger>
      <TooltipContent>{t('nav.costEstimate')}</TooltipContent>
    </Tooltip>
  )
}

/** Across the agents, a reached window first, then the fullest. */
function tightestOf(
  agents: AgentStatus[],
  now: number,
): { agent: AgentStatus; limit: PlanLimit } | null {
  let best: { agent: AgentStatus; limit: PlanLimit } | null = null
  for (const agent of agents) {
    const limit = tightestLimit(agent.limits, now)
    if (!limit || limit.usedPercent === null) continue
    const rank = (l: PlanLimit) => (l.state === 'reached' ? 1000 : 0) + (l.usedPercent ?? 0)
    if (!best || rank(limit) > rank(best.limit)) best = { agent, limit }
  }
  return best
}

function TightestLimit() {
  const { t } = useTranslation('usage')
  const agents = useAgentsStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((a): a is AgentStatus => !!a && a.limits.length > 0),
    ),
  )
  const tightest = tightestOf(agents, useNow())
  if (!tightest) return null
  const { agent, limit } = tightest
  const percent = `${Math.round(limit.usedPercent ?? 0)}%`
  const tone = usageTone(limit)
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 text-xs font-normal tabular-nums',
        USAGE_TONE_TEXT[tone],
        tone === 'success' && 'group-data-active/menu-button:text-secondary',
      )}
    >
      <AgentMark agent={agent.id} size={12} />
      <span aria-hidden className="truncate">
        {t('nav.limitShort', { limit: limitLabel(limit), percent })}
      </span>
      <span className="sr-only">
        {t('nav.limit', { agent: agent.name, limit: limitLabel(limit), percent })}
      </span>
    </span>
  )
}

/** A project's sessions, or with a null project those started with No project, if any. */
function ProjectGroup({
  project,
  stop,
  onImport,
}: {
  project: Project | null
  stop: SidebarTabStop | null
  onImport: (project: Project) => void
}) {
  const key = project?.path ?? NO_PROJECT_GROUP
  const { t } = useTranslation('sidebar')
  const name = project?.name ?? t('project.noProject')
  const open = useViewStore((s) => !s.collapsedProjects[key])
  const [moreOpen, setMoreOpen] = useState(false)
  const summaries = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter((x) => (project ? x.projectPath === project.path : x.scratch)),
    ),
  )
  const projectPath = project?.path ?? null
  const tree = useMemo(
    () => sessionTree(Object.fromEntries(summaries.map((x) => [x.id, x])), projectPath),
    [summaries, projectPath],
  )
  if (!project && tree.length === 0) return null

  const toggle = () => toggleGroup(key)
  const groupStop = stop?.kind === 'group' && stop.key === key
  const tabStopId = stop?.kind === 'session' ? stop.id : null

  const row = (
    <SidebarMenuButton
      size="label"
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
      className={cn(GROUP_LABEL, project?.missing ? 'text-disabled' : 'hover:text-secondary')}
    >
      <span className="min-w-0 truncate font-heading text-group font-medium">{name}</span>
      <FoldChevron open={open} />
    </SidebarMenuButton>
  )
  const tooltip = project ? (
    <TooltipContent side="right" className="max-w-sm font-mono break-all">
      {project.path}
    </TooltipContent>
  ) : (
    <TooltipContent side="right">{t('project.noProjectTooltip')}</TooltipContent>
  )
  const menuItems = project && <ProjectMenuItems onImport={() => onImport(project)} />

  return (
    <div className="flex flex-col gap-0.5">
      <div className={cn('group/menu-item', GROUP_ROW)}>
        {project ? (
          <ContextMenu>
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
        {project?.missing && (
          <span className="ml-1.5 shrink-0 text-meta text-tertiary">{t('project.missing')}</span>
        )}
        {/* Room for the More button and the +, so the name never runs under them. */}
        <span className="min-w-13 flex-1" />
        {project && (
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction
                        showOnHover
                        tabIndex={-1}
                        aria-label={t('row.more')}
                        className={cn(GROUP_ACTION, !project.missing && 'right-7.5')}
                      />
                    }
                  />
                }
              >
                <EllipsisIcon />
              </TooltipTrigger>
              <TooltipContent>{t('row.more')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">{menuItems}</DropdownMenuContent>
          </DropdownMenu>
        )}
        {!project?.missing && (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  showOnHover={!project}
                  aria-label={
                    project ? t('project.newSessionIn', { name }) : t('project.newSessionNoProject')
                  }
                  onClick={() => newSession(projectPath, !project)}
                  className={GROUP_ACTION}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent>
              {project ? t('project.newSessionIn', { name }) : t('project.newSessionNoProject')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {open && tree.length > 0 && (
        <SidebarMenu className="gap-0.5">
          {tree.map((node) => (
            <SessionRow key={node.summary.id} node={node} tabStopId={tabStopId} />
          ))}
        </SidebarMenu>
      )}
    </div>
  )
}

// A group's label row: the label hugs its name, as a heading over its rows, with its buttons at
// the row's end.
const GROUP_ROW = 'relative mt-3.5 flex h-[30px] items-center pr-1 pl-2.5'
const GROUP_LABEL = '-ml-1.5 min-w-0 group-has-data-[sidebar=menu-action]/menu-item:pr-1.5'
const GROUP_ACTION =
  'top-[3px] right-1 w-6 text-tertiary peer-hover/menu-button:text-tertiary [&>svg]:size-3.5'

function FoldChevron({ open }: { open: boolean }) {
  return (
    <span className="grid size-3 shrink-0 place-items-center text-icon">
      {open ? <ChevronDownIcon className="size-3!" /> : <ChevronRightIcon className="size-3!" />}
    </span>
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

/** The pinned sessions across the projects, above them, while there are any. */
function PinnedGroup({ stop }: { stop: SidebarTabStop | null }) {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => !s.collapsedProjects[PINNED_GROUP])
  const summaries = useSessionsStore(
    useShallow((s) => Object.values(s.byId).filter((x) => inPinnedTree(s.byId, x))),
  )
  const tree = useMemo(
    () => pinnedTree(Object.fromEntries(summaries.map((x) => [x.id, x]))),
    [summaries],
  )
  if (tree.length === 0) return null
  const toggle = () => toggleGroup(PINNED_GROUP)
  const tabStopId = stop?.kind === 'session' ? stop.id : null
  return (
    <div className="flex flex-col gap-0.5">
      <div className={GROUP_ROW}>
        <SidebarMenuButton
          size="label"
          data-sidebar-row=""
          tabIndex={stop?.kind === 'group' && stop.key === PINNED_GROUP ? 0 : -1}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' && !open) toggle()
            else if (event.key === 'ArrowLeft' && open) toggle()
          }}
          className={cn(GROUP_LABEL, 'text-xs font-medium text-tertiary hover:text-secondary')}
        >
          <span className="min-w-0 truncate">{t('pinned.label')}</span>
          <FoldChevron open={open} />
        </SidebarMenuButton>
      </div>
      {open && (
        <SidebarMenu className="gap-0.5">
          {tree.map((node) => (
            <SessionRow key={node.summary.id} node={node} tabStopId={tabStopId} />
          ))}
        </SidebarMenu>
      )}
    </div>
  )
}

/** A project's actions, one list for its row's context menu and its More button. */
function ProjectMenuItems({ onImport }: { onImport: () => void }) {
  const { t } = useTranslation('sidebar')
  return (
    <DropdownMenuItem onClick={onImport}>
      <HistoryIcon />
      {t('project.importSessions')}
    </DropdownMenuItem>
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
