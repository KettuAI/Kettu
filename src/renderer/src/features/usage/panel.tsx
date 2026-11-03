import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

/** One of the usage page's cards, raised on the sheet. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn('flex min-w-0 flex-col rounded-xl bg-card px-5 py-4.5 shadow-card', className)}
    >
      {children}
    </section>
  )
}

/** A card's title. */
export function PanelTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn('text-row font-semibold text-primary', className)}>{children}</h2>
}
