import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  ChartNoAxesColumnIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  PlusIcon,
  ShapesIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, PlanLimit, Project } from '@shared/agent-host'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { dayOf } from '@renderer/features/usage/model'
import { limitLabel, tokens } from '@renderer/lib/format'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTree, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { loadToday, useUsageStore } from '@renderer/stores/usage'
import { NO_PROJECT_GROUP, openUsage, useViewStore } from '@renderer/stores/view'
import { ImportSessionsDialog } from './import-sessions'
import { tightestLimit, USAGE_TONE_TEXT, usageTone } from './plan-usage'
import { SessionRow } from './session-row'
import { SidebarFooterContent } from './sidebar-footer'

export function AppSidebar() {
  const { t } = useTranslation('sidebar')
  const projects = useProjectsStore((s) => s.projects)
  const projectsLoaded = useProjectsStore((s) => s.loaded)
  const sessionsLoaded = useSessionsStore((s) => s.loaded)
  const loaded = projectsLoaded && sessionsLoaded
  const loadError = useProjectsStore((s) => s.error)
  const drafting = useViewStore((s) => s.main.kind === 'new' && !s.settings.open)

  return (
    <Sidebar collapsible="none" className="w-full" aria-label={t('nav.label')}>
      <div className="app-region-drag flex h-top-bar shrink-0 items-center gap-2 pr-2.5 pl-4">
        {isMac && <span aria-hidden className="w-(--traffic-lights)" />}
        <span className="flex-1" />
        <SidebarToggle />
      </div>
      <div className="flex shrink-0 flex-col gap-px px-2 pt-0.5 pb-2.5">
        <NavRow
          icon={<PlusIcon className="text-muted-foreground" />}
          label={t('nav.newSession')}
          shortcut="Mod+N"
          current={drafting}
          onClick={() => newSession()}
        />
        <Tooltip>
          {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
          <TooltipTrigger render={<span className="flex" />}>
            <NavRow
              icon={<ShapesIcon className="text-muted-foreground" />}
              label={t('nav.artifacts')}
              disabled
            />
          </TooltipTrigger>
          <TooltipContent side="right">{t('nav.artifactsLater')}</TooltipContent>
        </Tooltip>
        <UsageNavRow />
      </div>
      <SidebarContent className="scroll-fade-y gap-0 px-2" onKeyDown={moveRowFocus}>
        {/* No header row: projects are added with Mod+O, the File menu or New session. */}
        <SidebarGroup role="group" aria-label={t('nav.projects')} className="gap-0.5 p-0">
          {!loaded && loadError ? (
            <p className="px-2 py-1 text-xs leading-normal text-muted-foreground">
              {t('nav.unavailable')}
            </p>
          ) : !loaded ? (
            <SidebarMenu className="gap-px">
              {[0, 1, 2, 3].map((i) => (
                <SidebarMenuItem key={i}>
                  <SidebarMenuSkeleton className="h-row" />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            <>
              {projects.length === 0 ? (
                <p className="px-2 py-1 text-xs leading-normal text-muted-foreground">
                  {t('nav.empty')}
                </p>
              ) : (
                projects.map((project) => <ProjectGroup key={project.path} project={project} />)
              )}
              <ProjectGroup project={null} />
            </>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-1 p-2">
        <SidebarFooterContent />
      </SidebarFooter>
    </Sidebar>
  )
}

export function NavRow({
  icon,
  label,
  shortcut,
  current,
  disabled,
  onClick,
  extra,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  current?: boolean
  disabled?: boolean
  onClick?: () => void
  extra?: React.ReactNode
}) {
  return (
    <SidebarMenuButton
      size="row"
      isActive={current}
      disabled={disabled}
      onClick={onClick}
      className="[&_svg]:size-[15px] data-active:font-medium"
    >
      {icon}
      <span className="flex-1">{label}</span>
      {extra ??
        (shortcut && (
          <Kbd className="h-auto bg-transparent p-0 text-[11px] font-normal text-muted-foreground">
            {formatShortcut(shortcut)}
          </Kbd>
        ))}
    </SidebarMenuButton>
  )
}

/** The Usage row; its end shows today's tokens or the tightest plan limit, as Settings chooses. */
function UsageNavRow() {
  const { t } = useTranslation('usage')
  const current = useViewStore((s) => s.main.kind === 'usage' && !s.settings.open)
  const end = useSettingsStore((s) => s.settings.usage.sidebar)
  return (
    <NavRow
      icon={<ChartNoAxesColumnIcon className="text-muted-foreground" />}
      label={t('nav.usage')}
      current={current}
      onClick={openUsage}
      extra={end === 'today' ? <TodayTokens /> : end === 'limit' ? <TightestLimit /> : undefined}
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
    <span className="text-xs font-normal text-muted-foreground tabular-nums">
      <span aria-hidden>{tokens(today)}</span>
      <span className="sr-only">{t('nav.today', { tokens: tokens(today) })}</span>
    </span>
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
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground tabular-nums',
        USAGE_TONE_TEXT[usageTone(limit)],
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
function ProjectGroup({ project }: { project: Project | null }) {
  const key = project?.path ?? NO_PROJECT_GROUP
  const { t } = useTranslation('sidebar')
  const name = project?.name ?? t('project.noProject')
  const open = useViewStore((s) => !s.collapsedProjects[key])
  const [moreOpen, setMoreOpen] = useState(false)
  const [importing, setImporting] = useState(false)
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
  if (!project && summaries.length === 0) return null

  const toggle = () =>
    useViewStore.setState((s) => {
      const collapsedProjects = { ...s.collapsedProjects }
      if (collapsedProjects[key]) delete collapsedProjects[key]
      else collapsedProjects[key] = true
      return { collapsedProjects }
    })

  const row = (
    <SidebarMenuButton
      size="row"
      data-sidebar-row=""
      tabIndex={-1}
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
        'gap-1 font-medium',
        // Room for the More button before the +, so the name never runs under it.
        project && !project.missing && 'group-has-data-[sidebar=menu-action]/menu-item:pr-13',
        project?.missing && 'text-muted-foreground',
      )}
    >
      <span className="min-w-0 truncate">{name}</span>
      {/* A folded group always shows its chevron; an open one only under the pointer. */}
      <span
        className={cn(
          'grid size-3.5 shrink-0 place-items-center text-muted-foreground transition-opacity duration-(--duration-fast)',
          open &&
            'opacity-0 group-hover/menu-item:opacity-100 group-has-focus-visible/menu-item:opacity-100',
        )}
      >
        {open ? <ChevronDownIcon className="size-3!" /> : <ChevronRightIcon className="size-3!" />}
      </span>
      {project?.missing && (
        <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">
          {t('project.missing')}
        </span>
      )}
    </SidebarMenuButton>
  )
  const tooltip = project ? (
    <TooltipContent side="right" className="max-w-sm font-mono break-all">
      {project.path}
    </TooltipContent>
  ) : (
    <TooltipContent side="right">{t('project.noProjectTooltip')}</TooltipContent>
  )
  const menuItems = <ProjectMenuItems onImport={() => setImporting(true)} />

  return (
    <div className="flex flex-col gap-px">
      <div className="group/menu-item relative">
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
        {project && (
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              render={
                <SidebarMenuAction
                  showOnHover
                  tabIndex={-1}
                  aria-label={t('row.more')}
                  className={cn(
                    'top-1 text-muted-foreground [&>svg]:size-3.5',
                    !project.missing && 'right-6.5',
                  )}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
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
                  className="top-1 text-muted-foreground [&>svg]:size-3.5"
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
        <SidebarMenu className="gap-px">
          {tree.map((node) => (
            <SessionRow key={node.summary.id} node={node} />
          ))}
        </SidebarMenu>
      )}
      {project && (
        <ImportSessionsDialog project={project} open={importing} onOpenChange={setImporting} />
      )}
    </div>
  )
}

/** A project's actions, one list for its row's context menu and its More button. */
function ProjectMenuItems({ onImport }: { onImport: () => void }) {
  const { t } = useTranslation('sidebar')
  return <DropdownMenuItem onClick={onImport}>{t('project.importSessions')}</DropdownMenuItem>
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
