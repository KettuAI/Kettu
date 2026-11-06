import type { ComponentProps, ReactNode } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  SidebarRightIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { hasBand } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { toggleSidePane, useViewStore, type SidePane } from '@renderer/stores/view'
import { SHEET } from './sheet'

/** A hugeicons glyph at the shell's stroke. */
export function PaneIcon({
  icon,
  size = 15,
  className,
}: {
  icon: IconSvgElement
  size?: number
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={1.9}
      aria-hidden
      className={cn('shrink-0', className)}
    />
  )
}

/** An icon button in a side pane: 28 px, its glyph muted until hovered or pressed. */
export function PanelButton({
  label,
  shortcut,
  pressed,
  disabled,
  size = 'icon-sm',
  className,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  pressed?: boolean
  disabled?: boolean
  /** 28 px, or 24 px where a row is short. */
  size?: 'icon-xs' | 'icon-sm'
  className?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              'kp-tool app-region-no-drag',
              size === 'icon-xs' && 'kp-tool--sm',
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A side pane: a sheet of its own beside the main area, its head on top and its body under it.
 * Maximized, it leaves its slot and covers the whole area.
 */
export function PaneSheet({
  pane,
  maximized,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { pane: string; maximized: boolean }) {
  return (
    <div
      data-pane={pane}
      className={cn(
        'kp-pane animate-in fade-in animation-duration-(--duration-fast)',
        SHEET,
        maximized && 'absolute inset-0 z-10',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * A pane's own head: its tabs or title on the left, then its tools, Maximize and the button that
 * folds the pane away. It is a window drag region, so everything in it opts out.
 */
export function PaneHead({
  panel,
  pane,
  maximized,
  tools,
  onCollapse,
  children,
}: {
  panel: string
  pane: SidePane
  maximized: boolean
  tools?: ReactNode
  /** What folding the pane away does besides hiding it. */
  onCollapse?: () => void
  children?: ReactNode
}) {
  const { t } = useTranslation('common')
  // On macOS, maximized with the sidebar collapsed, the head is the window's top left corner.
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && !hasBand
  return (
    <div className={cn('kp-head app-region-drag', cornered && 'kp-head--cornered')}>
      {cornered && <CornerControlsSpace className="mr-1" />}
      <div className="kp-head__main">{children}</div>
      <div className="kp-head__tools app-region-no-drag">
        {tools}
        <PanelButton
          label={maximized ? t('pane.restore') : t('pane.maximize')}
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          <PaneIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} />
        </PanelButton>
        <PanelButton
          label={t('pane.collapse')}
          onClick={() => {
            onCollapse?.()
            toggleSidePane(panel, pane, false)
          }}
        >
          <PaneIcon icon={SidebarRightIcon} size={16} />
        </PanelButton>
      </div>
    </div>
  )
}

/** A tab's close button: on the chosen tab at its end, on another over its end on hover. */
export function PaneTabClose({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="kp-tab__x"
    >
      <PaneIcon icon={Cancel01Icon} size={11} />
    </button>
  )
}

/** A pane's empty or waiting state, in its middle. */
export function PaneEmpty({
  icon,
  title,
  text,
  className,
  children,
}: {
  icon?: ReactNode
  title: ReactNode
  text?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={cn('kp-empty', className)}>
      {icon && <span className="kp-empty__icon">{icon}</span>}
      <b>{title}</b>
      {text && <p>{text}</p>}
      {children}
    </div>
  )
}

/** The spinner a pane shows while something starts. */
export function PaneSpinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn('kp-spin', className)} />
}
