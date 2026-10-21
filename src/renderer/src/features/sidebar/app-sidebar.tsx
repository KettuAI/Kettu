import { useMemo, type KeyboardEvent } from 'react'
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, SquarePenIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
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
import { openProjectHome, useViewStore } from '@renderer/stores/view'
import { SessionRow } from './session-row'
import { SidebarFooterContent } from './sidebar-footer'

export function AppSidebar() {
  const projects = useProjectsStore((s) => s.projects)
  const projectsLoaded = useProjectsStore((s) => s.loaded)
  const sessionsLoaded = useSessionsStore((s) => s.loaded)
  const loaded = projectsLoaded && sessionsLoaded
  const loadError = useProjectsStore((s) => s.error)

  return (
    <Sidebar collapsible="none" className="w-full" aria-label="Projects and sessions">
      <div className="app-region-drag flex h-top-bar shrink-0 items-center gap-2 pr-2.5 pl-4">
        {isMac && <span aria-hidden className="w-[52px]" />}
        <span className="flex-1" />
        <SidebarToggle />
      </div>
      <div className="shrink-0 px-2 pt-0.5 pb-2.5">
        <NavRow
          icon={<SquarePenIcon className="text-muted-foreground" />}
          label="New session"
          shortcut="Mod+N"
          onClick={newSession}
        />
      </div>
      <SidebarContent className="gap-0 px-2" onKeyDown={moveRowFocus}>
        <SidebarGroup className="gap-0.5 p-0">
          <div className="flex h-6 items-center pr-1 pl-2">
            <SidebarGroupLabel className="h-auto flex-1 p-0 text-xs font-medium text-muted-foreground">
              Projects
            </SidebarGroupLabel>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Open project"
                    onClick={() => void openProjectDialog()}
                    className="size-5 rounded-md text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>
                Open project <span className="opacity-60">{formatShortcut('Mod+O')}</span>
              </TooltipContent>
            </Tooltip>
          </div>
          {!loaded && loadError ? (
            <p className="px-2 py-1 text-xs leading-normal text-muted-foreground">
              Projects are unavailable right now.
            </p>
          ) : !loaded ? (
            <SidebarMenu className="gap-px">
              {[0, 1, 2, 3].map((i) => (
                <SidebarMenuItem key={i}>
                  <SidebarMenuSkeleton className="h-row" />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : projects.length === 0 ? (
            <p className="px-2 py-1 text-xs leading-normal text-muted-foreground">
              Projects you open appear here.
            </p>
          ) : (
            projects.map((project) => <ProjectGroup key={project.path} project={project} />)
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
  shortcut: string
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
      {extra ?? (
        <Kbd className="h-auto bg-transparent p-0 text-[11px] font-normal text-muted-foreground">
          {formatShortcut(shortcut)}
        </Kbd>
      )}
    </SidebarMenuButton>
  )
}

function ProjectGroup({ project }: { project: Project }) {
  const open = useViewStore((s) => !s.collapsedProjects[project.path])
  const current = useViewStore(
    (s) => s.projectPath === project.path && s.main.kind === 'home' && !s.settings.open,
  )
  const summaries = useSessionsStore(
    useShallow((s) => Object.values(s.byId).filter((x) => x.projectPath === project.path)),
  )
  const tree = useMemo(
    () => sessionTree(Object.fromEntries(summaries.map((x) => [x.id, x])), project.path),
    [summaries, project.path],
  )

  const toggle = () =>
    useViewStore.setState((s) => {
      const collapsedProjects = { ...s.collapsedProjects }
      if (collapsedProjects[project.path]) delete collapsedProjects[project.path]
      else collapsedProjects[project.path] = true
      return { collapsedProjects }
    })

  return (
    <div className="flex flex-col gap-px">
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
                if (current || !open) toggle()
                openProjectHome(project.path)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' && !open) toggle()
                else if (event.key === 'ArrowLeft' && open) toggle()
              }}
              className={cn('gap-1.5 font-medium', project.missing && 'text-muted-foreground')}
            />
          }
        >
          <span
            role="presentation"
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            className="grid size-3.5 place-items-center text-muted-foreground"
          >
            {open ? (
              <ChevronDownIcon strokeWidth={2} className="size-3!" />
            ) : (
              <ChevronRightIcon strokeWidth={2} className="size-3!" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {project.missing && (
            <span className="text-[11.5px] font-normal text-muted-foreground">Missing</span>
          )}
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-sm font-mono break-all">
          {project.path}
        </TooltipContent>
      </Tooltip>
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
