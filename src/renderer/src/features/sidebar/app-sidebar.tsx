import { useMemo, type KeyboardEvent } from 'react'
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, SquarePenIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import { newSession } from '@renderer/app/actions'
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
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTree, useSessionsStore } from '@renderer/stores/sessions'
import { NO_PROJECT_GROUP, openProjectHome, useViewStore } from '@renderer/stores/view'
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
      <div className="shrink-0 px-2 pt-0.5 pb-2.5">
        <NavRow
          icon={<SquarePenIcon className="text-muted-foreground" />}
          label={t('nav.newSession')}
          shortcut="Mod+N"
          current={drafting}
          onClick={() => newSession()}
        />
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
  onClick,
  extra,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  current?: boolean
  onClick: () => void
  extra?: React.ReactNode
}) {
  return (
    <SidebarMenuButton
      size="row"
      isActive={current}
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

/** A project's sessions, or with a null project those started with No project, if any. */
function ProjectGroup({ project }: { project: Project | null }) {
  const key = project?.path ?? NO_PROJECT_GROUP
  const { t } = useTranslation('sidebar')
  const name = project?.name ?? t('project.noProject')
  const open = useViewStore((s) => !s.collapsedProjects[key])
  const current = useViewStore(
    (s) =>
      !!project && s.projectPath === project.path && s.main.kind === 'home' && !s.settings.open,
  )
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

  return (
    <div className="flex flex-col gap-px">
      <div className="group/menu-item relative">
        <Tooltip>
          <TooltipTrigger
            delay={700}
            render={
              <SidebarMenuButton
                size="row"
                isActive={current}
                data-sidebar-row=""
                tabIndex={-1}
                aria-expanded={open}
                onClick={() => {
                  // No project has no home, so its name only folds the group.
                  if (current || !open || !project) toggle()
                  if (project) openProjectHome(project.path)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' && !open) toggle()
                  else if (event.key === 'ArrowLeft' && open) toggle()
                }}
                className={cn('gap-1 font-medium', project?.missing && 'text-muted-foreground')}
              />
            }
          >
            <span className="min-w-0 truncate">{name}</span>
            {/* A folded group always shows its chevron; an open one only under the pointer. */}
            <span
              role="presentation"
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
              className={cn(
                'grid size-3.5 shrink-0 place-items-center text-muted-foreground transition-opacity duration-(--duration-fast)',
                open &&
                  'opacity-0 group-hover/menu-item:opacity-100 group-has-focus-visible/menu-item:opacity-100',
              )}
            >
              {open ? (
                <ChevronDownIcon className="size-3!" />
              ) : (
                <ChevronRightIcon className="size-3!" />
              )}
            </span>
            {project?.missing && (
              <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">
                {t('project.missing')}
              </span>
            )}
          </TooltipTrigger>
          {project ? (
            <TooltipContent side="right" className="max-w-sm font-mono break-all">
              {project.path}
            </TooltipContent>
          ) : (
            <TooltipContent side="right">{t('project.noProjectTooltip')}</TooltipContent>
          )}
        </Tooltip>
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
