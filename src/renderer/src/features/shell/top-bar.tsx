import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BackForward } from '@renderer/features/shell/back-forward'
import { useNotices } from '@renderer/features/sidebar/notices'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { toggleSidebar, useViewStore } from '@renderer/stores/view'

/**
 * The top bar of the main area, at the top of its sheet: the window's drag region. On macOS with
 * the sidebar collapsed it leaves room for the traffic lights and carries the sidebar toggle with
 * Back and Forward, which on Windows and Linux sit in the band above the sheets instead.
 */
export function TopBar({
  children,
  className,
  cornered: given,
}: {
  children: ReactNode
  className?: string
  /** Whether it may take the window's top left corner; with the sidebar shown, none does. */
  cornered?: boolean
}) {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const cornered = (given ?? true) && collapsed && isMac
  return (
    <header
      className={cn(
        '@container/top-bar app-region-drag flex h-top-bar shrink-0 items-center gap-2.5 bg-app pr-2.5 pl-4 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
        cornered && 'pl-[calc(32px-var(--sheet-gap)+var(--traffic-lights))]',
        className,
      )}
    >
      {cornered && <CornerControls className="-ml-1" />}
      {children}
    </header>
  )
}

/**
 * Windows and Linux: the band of desk across the top of the main area, beside the window controls.
 * It drags the window and, while the sidebar is collapsed, holds the sidebar toggle with Back and
 * Forward.
 */
export function TitleBand() {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  if (isMac) return null
  return (
    <div className="app-region-drag absolute inset-x-0 top-0 flex h-(--title-bar) items-center pl-(--sheet-gap)">
      {collapsed && <CornerControls />}
    </div>
  )
}

/** Where the collapsed sidebar's toggle shows: the toggle, then Back and Forward. */
export function CornerControls({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <SidebarToggle />
      <BackForward />
    </div>
  )
}

/** Something clickable inside the drag region. */
export function NoDrag({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('app-region-no-drag flex items-center', className)}>{children}</div>
}

// The sidebar is inert while collapsed, and the top bar's toggle goes once it shows, so the toggle
// in the other place takes the focus when the sidebar hides with the focus in it or shows from the
// top bar's toggle. Read as the state changes, before the page does.
let handOff = false
useViewStore.subscribe((state, previous) => {
  if (state.sidebarCollapsed === previous.sidebarCollapsed) return
  handOff = !!document.activeElement?.closest(
    state.sidebarCollapsed ? '[data-slot=sidebar]' : '[data-sidebar-toggle]',
  )
})

export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useTranslation('shell')
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const { summary } = useNotices()
  const button = useRef<HTMLButtonElement>(null)
  // Collapsed, the top bar's toggle takes the focus; shown, the sidebar's.
  useLayoutEffect(() => {
    const element = button.current
    if (!handOff || !element || !!element.closest('[data-slot=sidebar]') === collapsed) return
    handOff = false
    element.focus()
  }, [collapsed])
  // Collapsed, the sidebar's notices are out of sight, so the toggle marks and names them.
  const notices = collapsed ? summary : null
  const label = collapsed ? t('topBar.showSidebar') : t('topBar.hideSidebar')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={button}
            data-sidebar-toggle=""
            variant="quiet"
            size="icon-compact"
            aria-label={label}
            aria-description={notices?.name}
            onClick={toggleSidebar}
            className={cn('app-region-no-drag relative text-secondary', className)}
          />
        }
      >
        <PanelLeftIcon />
        {notices && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </TooltipTrigger>
      {/* Notice lines end in text, not the keycap, so they keep the full end padding. */}
      <TooltipContent
        className={notices ? 'flex-col items-start gap-0.5 has-data-[slot=kbd]:pr-3' : undefined}
      >
        <span className="inline-flex items-center gap-1.5">
          {label}
          <Kbd>{formatShortcut('Mod+B')}</Kbd>
        </span>
        {notices?.labels.map((notice) => (
          <span key={notice} className="opacity-60">
            {notice}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
