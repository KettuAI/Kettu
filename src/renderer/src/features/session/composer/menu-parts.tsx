import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

// The composer's menus share their rows' parts: a name over a line that says what it does.

/** A row's name, with what it does under it when given. */
export function ItemText({
  name,
  description,
  danger = false,
  className,
}: {
  name: ReactNode
  description?: ReactNode
  /** The one choice that removes a safeguard, as Full access does. */
  danger?: boolean
  className?: string
}) {
  return (
    <span className={cn('flex min-w-0 flex-1 flex-col', className)}>
      <span className={cn('truncate', danger && 'text-danger')}>{name}</span>
      {description && (
        <span className="text-small whitespace-normal text-tertiary">{description}</span>
      )}
    </span>
  )
}

/** A described row's classes: its icons sit on the name's line, not the middle of both. */
export const DESCRIBED_ROW = 'items-start py-1.5 [&>svg]:mt-0.5 [&>[data-slot=menu-check]]:mt-0.5'

/** The 16 px column a menu's check sits in, empty on the rows not chosen. */
export function CheckColumn({ children }: { children?: ReactNode }) {
  return (
    <span data-slot="menu-check" className="flex w-4 shrink-0 justify-center text-primary">
      {children}
    </span>
  )
}

/** A control row's button: 30 px, its label in the row's quiet ink, the ink of text while open. */
export const ROW_BUTTON =
  'h-7.5 gap-1.5 rounded-tile px-2 text-control font-normal text-tertiary aria-expanded:bg-selected aria-expanded:text-primary [&_svg:not([class*=size-])]:size-3.5'
