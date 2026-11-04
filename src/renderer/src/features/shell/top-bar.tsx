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

/** The main sheet's drag region, leaving room for the window's controls when cornered. */
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
        className,
        cornered && 'pl-(--corner-inset)',
      )}
    >
      {cornered && <CornerControlsSpace divided={children != null} />}
      {children}
    </header>
  )
}

/** The drag region beside the window controls on Windows and Linux. */
export function TitleBand() {
  if (!hasBand) return null
  return <div className="app-region-drag absolute inset-x-0 top-0 h-(--title-bar)" />
}

/** The sidebar's drag region and the history dialog, which stays mounted with it. */
export function SidebarTitleBar() {
  return (
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center pr-2',
        hasBand
          ? 'h-(--title-bar) pl-(--sheet-gap)'
          : 'h-14 pt-2 pl-[calc(var(--corner-inset)+var(--sheet-gap))]',
      )}
    >
      <CornerControlsSpace />
      <span className="flex-1" />
      <HistoryDialog />
    </div>
  )
}

/** One mounted set of controls, outside the panels that slide beneath it. */
export function CornerControls() {
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-0 left-0 z-20 flex items-center',
        hasBand
          ? 'h-(--title-bar) pl-(--sheet-gap)'
          : 'h-14 pt-2 pl-[calc(var(--corner-inset)+var(--sheet-gap))]',
      )}
    >
      <div className={cn('pointer-events-auto flex items-center gap-0.5', !hasBand && '-ml-0.5')}>
        <SidebarToggle />
        <BackForward />
      </div>
    </div>
  )
}

/** Reserves the controls' width in a header without moving the controls into that panel. */
export function CornerControlsSpace({
  className,
  divided = false,
}: {
  className?: string
  divided?: boolean
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 items-center',
        !hasBand && '-ml-0.5',
        // No line before the bar's spacer, as on New session, where nothing follows on the left.
        divided &&
          'mr-1.5 pr-2.5 shadow-[inset_calc(-1*var(--hairline))_0_0_var(--border-subtle)] [&:has(+_.flex-1)]:shadow-none',
        className,
      )}
    >
      <span className="h-7.5 w-23.5 shrink-0" />
    </div>
  )
}

/** Something clickable inside the drag region. */
export function NoDrag({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('app-region-no-drag flex items-center', className)}>{children}</div>
}

export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useTranslation('shell')
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const { summary } = useNotices()
  const button = useRef<HTMLButtonElement>(null)
  // Move focus out of the sidebar before collapsing makes it inert.
  useLayoutEffect(
    () =>
      useViewStore.subscribe((state, previous) => {
        if (!state.sidebarCollapsed || previous.sidebarCollapsed) return
        if (document.activeElement?.closest('[data-slot=sidebar]')) button.current?.focus()
      }),
    [],
  )
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
            className={cn(
              TITLE_BUTTON,
              'relative active:not-aria-[haspopup]:translate-y-0',
              className,
            )}
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
