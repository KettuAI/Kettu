import type { ComponentProps, ReactNode } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

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
  unavailable,
  size = 'icon-sm',
  className,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  pressed?: boolean
  disabled?: boolean
  /** Dimmed and without effect, yet still focusable, so the keyboard's focus stays on it. */
  unavailable?: boolean
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
            aria-disabled={unavailable || undefined}
            onClick={unavailable ? undefined : onClick}
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

/** What a tab of the side panel shows, under the row of tabs: its context bar, then its content. */
export function PaneBody({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('kp-tabpane', className)} {...props}>
      {children}
    </div>
  )
}

/**
 * The context bar under the row of tabs: where the selected tab is on the left, its own tools on
 * the right.
 */
export function PaneContext({ tools, children }: { tools?: ReactNode; children?: ReactNode }) {
  return (
    <div className="kp-ctx">
      <div className="kp-ctx__main">{children}</div>
      {tools && <div className="kp-ctx__tools">{tools}</div>}
    </div>
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
