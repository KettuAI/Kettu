import type { ReactNode } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { toggleSidebar, useViewStore } from '@renderer/stores/view'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useBesideSidePanel } from './side-panel'

/**
 * The 40 px top bar of the main area: the window's drag region. With the sidebar collapsed it
 * leaves room for the macOS traffic lights and carries the sidebar toggle; on Windows and Linux it
 * leaves room for the window controls unless the side panel takes the window's right edge.
 */
export function TopBar({ children, className }: { children: ReactNode; className?: string }) {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const besidePanel = useBesideSidePanel()
  return (
    <header
      className={cn(
        'app-region-drag flex h-top-bar shrink-0 items-center gap-2.5 pr-2.5 pl-5',
        collapsed && (isMac ? 'pl-[84px]' : 'pl-2'),
        !isMac &&
          !besidePanel &&
          'pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+10px)]',
        className,
      )}
    >
      {collapsed && <SidebarToggle className="-ml-1" />}
      {children}
    </header>
  )
}

/** Something clickable inside the drag region. */
export function NoDrag({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('app-region-no-drag flex items-center', className)}>{children}</div>
}

export function SidebarToggle({ className }: { className?: string }) {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const update = useUpdatesStore((s) => s.status)
  const updateReady =
    collapsed &&
    update &&
    update.dismissed !== versionOf(update.state) &&
    (update.state.kind === 'ready' ||
      (update.state.kind === 'available' && update.state.mode === 'link'))
  const label = collapsed ? 'Show sidebar' : 'Hide sidebar'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={toggleSidebar}
            className={cn(
              'app-region-no-drag relative text-muted-foreground hover:text-foreground',
              className,
            )}
          />
        }
      >
        <PanelLeftIcon className="size-4" />
        {updateReady && (
          <span
            aria-hidden
            className="absolute top-[3px] right-[3px] size-1.5 rounded-full bg-foreground ring-2 ring-background"
          />
        )}
      </TooltipTrigger>
      <TooltipContent className={updateReady ? 'flex-col items-start gap-0.5' : undefined}>
        <span>
          {label} <span className="opacity-60">{formatShortcut('Mod+B')}</span>
        </span>
        {updateReady && update && (
          <span className="opacity-60">
            OverBench {versionOf(update.state)} is ready to install
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function versionOf(state: { kind: string; version?: string }): string | null {
  return 'version' in state ? (state.version ?? null) : null
}

/** A hairline between groups of top bar controls. */
export function TopBarRule() {
  return <span aria-hidden className="mx-1 h-4 w-(--hairline) shrink-0 bg-border" />
}
