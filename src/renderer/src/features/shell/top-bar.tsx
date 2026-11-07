import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { SidebarLeftIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { BackForward } from '@renderer/features/shell/back-forward'
import { HistoryDialog } from '@renderer/features/shell/history-dialog'
import { TITLE_BUTTON } from '@renderer/features/shell/title-button'
import { useNotices } from '@renderer/features/sidebar/notices'
import { formatShortcut, hasBand } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { toggleSidebar, useViewStore } from '@renderer/stores/view'
import { useNarrowWindow } from './narrow'

/**
 * A sheet's head, as App Shell's chat bar: 52 px, the window's drag region. In the window's top
 * left corner, with the sidebar hidden, it starts after the toggle, Back and Forward.
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
  // A narrow window's sidebar is a drawer, so the main area always starts at the corner.
  const narrow = useNarrowWindow()
  const cornered = (given ?? true) && (collapsed || narrow) && !hasBand
  return (
    <header
      className={cn(
        '@container/top-bar app-region-drag flex h-top-bar shrink-0 items-center gap-2.5 bg-app pr-3 pl-5',
        className,
        cornered && 'pl-(--corner-inset)',
      )}
    >
      {cornered && <CornerControlsSpace />}
      {children}
    </header>
  )
}

/** The drag region beside the window controls on Windows and Linux. */
export function TitleBand() {
  if (!hasBand) return null
  return <div className="app-region-drag absolute inset-x-0 top-0 h-(--title-bar)" />
}

/**
 * The sidebar toggle, Back and Forward, in the window's top left corner after the traffic lights,
 * where they stay whether the sidebar shows or not; with them the history dialog.
 */
export function CornerControls() {
  return (
    <>
      <SidebarToggle />
      <BackForward />
      <HistoryDialog />
    </>
  )
}

/** Reserves the corner controls' width in a head without moving the controls into that sheet. */
export function CornerControlsSpace({ className }: { className?: string; divided?: boolean }) {
  return (
    <div aria-hidden className={cn('flex shrink-0 items-center', className)}>
      {/* The three 28 px buttons with their 2 px gaps, then the 8 px before the head's content. */}
      <span className="h-7 w-24 shrink-0" />
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
  const drawer = useViewStore((s) => s.sidebarDrawer)
  // A narrow window's sidebar is a drawer, shown only while it is open.
  const shown = useNarrowWindow() ? drawer : !collapsed
  const { summary } = useNotices()
  const button = useRef<HTMLButtonElement>(null)
  // Move focus out of the sidebar before collapsing makes it inert.
  useLayoutEffect(
    () =>
      useViewStore.subscribe((state, previous) => {
        if (!state.sidebarCollapsed || previous.sidebarCollapsed) return
        if (document.activeElement?.closest('.ui-as-side')) button.current?.focus()
      }),
    [],
  )
  // Hidden, the sidebar's notices are out of sight, so the toggle marks and names them.
  const notices = shown ? null : summary
  const label = shown ? t('topBar.hideSidebar') : t('topBar.showSidebar')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={button}
            type="button"
            data-sidebar-toggle=""
            aria-label={label}
            aria-expanded={shown}
            aria-description={notices?.name}
            onClick={toggleSidebar}
            className={cn(TITLE_BUTTON, className)}
          />
        }
      >
        <Icon icon={SidebarLeftIcon} size={16} />
        {notices && (
          <span
            aria-hidden
            className="absolute top-1.25 right-1.25 size-1.5 rounded-full bg-attention-dot shadow-[0_0_0_1.5px_var(--bg-sidebar)]"
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
