import type { ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'

/** A pane button with its glyph; it spins while its own write runs and says why it cannot run. */
export function ActionBtn({
  icon,
  label,
  primary = false,
  busy = false,
  disabled = false,
  reason,
  className,
  onClick,
}: {
  icon?: IconSvgElement
  label: ReactNode
  primary?: boolean
  /** Its own write is running. */
  busy?: boolean
  disabled?: boolean
  /** Why it cannot run, shown on hover while it is disabled. */
  reason?: string | null
  className?: string
  onClick: () => void
}) {
  const button = (
    <Button
      variant={primary ? 'default' : 'outline'}
      size="sm"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={cn(busy && 'disabled:opacity-100', className)}
    >
      {busy ? <Spinner className="size-3.5" /> : icon && <Glyph icon={icon} size={14} />}
      <span className="truncate">{label}</span>
    </Button>
  )
  if (!reason || !disabled) return button
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so a wrapper holds the tooltip. */}
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

const TONE = {
  neutral: 'text-tertiary',
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
} as const

/** A page's note: its glyph in a tone, what it says, and the buttons that act on it. */
export function Note({
  icon,
  tone = 'neutral',
  children,
  actions,
}: {
  icon: IconSvgElement
  tone?: keyof typeof TONE
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl bg-subtle px-2.5 py-2 text-small text-secondary">
      <Glyph icon={icon} size={14} className={cn('shrink-0', TONE[tone])} />
      <span className="min-w-40 flex-1 [overflow-wrap:anywhere]">{children}</span>
      {actions && <span className="flex max-w-full flex-wrap items-center gap-1.5">{actions}</span>}
    </div>
  )
}

/** The padding a page's cards take inside the scrolling body. */
export const PAGE_PAD = 'px-0.5 pb-3'

/** A form field: its label over the control. */
export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-small font-medium text-secondary">
        {label}
      </label>
      {children}
    </div>
  )
}
