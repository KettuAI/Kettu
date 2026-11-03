import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { PanelLeftIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BackForward } from '@renderer/features/shell/back-forward'
import { HistoryDialog } from '@renderer/features/shell/history-dialog'
import { TITLE_BUTTON } from '@renderer/features/shell/title-button'
import { useNotices } from '@renderer/features/sidebar/notices'
import { formatShortcut, hasBand } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { toggleSidebar, useViewStore } from '@renderer/stores/view'

/**
 * The top bar of the main area, at the top of its sheet: the window's drag region. On macOS with
 * the sidebar collapsed it leaves room for the traffic lights and carries Back, Forward and the
 * sidebar toggle, which on Windows and Linux sit in the band above the sheets instead.
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
  const cornered = (given ?? true) && collapsed && !hasBand
  return (
    <header
      className={cn(
        '@container/top-bar app-region-drag flex h-top-bar shrink-0 items-center gap-2.5 bg-app pr-3 pl-4.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
        cornered && 'pl-(--corner-inset)',
        className,
      )}
    >
      {cornered && <CornerControls divided={children != null} className="-ml-0.5" />}
      {children}
    </header>
  )
}

/**
 * Windows and Linux: the band across the top of the main area, beside the window controls.
 * It drags the window and, while the sidebar is collapsed, holds Back, Forward and the sidebar
 * toggle.
 */
export function TitleBand() {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  if (!hasBand) return null
  return (
    <div className="app-region-drag absolute inset-x-0 top-0 flex h-(--title-bar) items-center pl-(--sheet-gap)">
      {collapsed && <CornerControls />}
    </div>
  )
}

/**
 * The sidebar's top row. Back, Forward and the toggle sit where the collapsed top bar puts them,
 * so hiding and showing the sidebar keeps that click: on macOS just past the traffic lights,
 * elsewhere at the title band's inset. The rest drags the window. The row holds the whole
 * history's dialog, since the sidebar stays mounted.
 */
export function SidebarTitleBar() {
  return (
    // On macOS 56 px, its buttons centred on the traffic lights, which main puts level with the
    // top bar's centre; elsewhere in the band. The inset is the cornered top bar's, measured from
    // the window's edge, and the same half-step pull-back, so the buttons do not move on collapse.
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center pr-2',
        hasBand
          ? 'h-(--title-bar) pl-(--sheet-gap)'
          : 'h-14 pt-2 pl-[calc(var(--corner-inset)+var(--sheet-gap))]',
      )}
    >
      <CornerControls className={cn(!hasBand && '-ml-0.5')} />
      {/* The window's drag region. */}
      <span className="flex-1" />
      <HistoryDialog />
    </div>
  )
}

/**
 * Back, Forward and the toggle, in the sidebar's row and, while it is collapsed, where that row
 * had them; `divided` sets them off with a line from what follows in the bar.
 */
export function CornerControls({
  className,
  divided = false,
}: {
  className?: string
  divided?: boolean
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5',
        // No line before the bar's spacer, as on New session, where nothing follows on the left.
        divided &&
          'mr-1.5 pr-2.5 shadow-[inset_calc(-1*var(--hairline))_0_0_var(--border-subtle)] [&:has(+_.flex-1)]:shadow-none',
        className,
      )}
    >
      <BackForward />
      <SidebarToggle />
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
            className={cn(TITLE_BUTTON, 'relative', className)}
          />
        }
      >
        <PanelLeftIcon className="size-4.5" />
        {notices && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </TooltipTrigger>
      {/* As Back's and Forward's beside it: the keys as plain text after the label. */}
      <TooltipContent className={cn('px-2.25 py-1.5', notices && 'flex-col items-start gap-0.5')}>
        <span>
          {label} <span className="opacity-60">{formatShortcut('Mod+B')}</span>
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
