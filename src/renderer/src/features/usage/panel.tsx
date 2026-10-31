import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

/** One of the usage page's cards: paper on the sheet, its title in the serif. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-xl bg-card px-4.5 pt-4 pb-4.5 shadow-card',
        className,
      )}
    >
      {children}
    </section>
  )
}

export function PanelHead({
  title,
  caption,
  aside,
}: {
  title: string
  /** A note beside the title. */
  caption?: ReactNode
  /** What the panel's end names, such as the bar under the pointer. */
  aside?: ReactNode
}) {
  return (
    <div className="mb-3.5 flex min-h-5.5 items-baseline gap-2.5">
      <h2 className="font-heading text-subheading font-medium">{title}</h2>
      {caption}
      <span className="flex-1" />
      {aside}
    </div>
  )
}

/**
 * What a chart's header names: the day or bar, then its amount in bold. Screen readers hear
 * `spoken` instead, which says what the amount counts.
 */
export function Readout({
  label,
  value,
  spoken,
}: {
  label: string
  value: string
  spoken: ReactNode
}) {
  return (
    <span
      aria-live="polite"
      className="inline-flex min-w-0 items-baseline gap-2 text-command whitespace-nowrap text-secondary"
    >
      <span aria-hidden className="truncate">
        {label}
      </span>
      <span aria-hidden className="font-semibold text-foreground tabular-nums">
        {value}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  )
}
