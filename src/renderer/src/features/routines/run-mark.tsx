// The small marks a routine's state and its runs show.

import { CircleAlertIcon, CircleCheckIcon, CircleSlashIcon } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import type { RunStatus } from '@shared/routines'

/** The dot that says work is going on; never the only sign of it. */
export function RunningDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('relative grid size-3.5 shrink-0 place-items-center', className)}
    >
      <span className="absolute inset-0 rounded-full bg-info/25 motion-safe:animate-ping" />
      <span className="size-1.5 rounded-full bg-info" />
    </span>
  )
}

/** A run's state as its icon; the row's words say the same, so it is not named again. */
export function RunMark({ status, className }: { status: RunStatus; className?: string }) {
  const common = cn('size-4 shrink-0', className)
  switch (status) {
    case 'succeeded':
      return <CircleCheckIcon aria-hidden className={cn(common, 'text-success')} />
    case 'failed':
    case 'timed_out':
      return <CircleAlertIcon aria-hidden className={cn(common, 'text-danger')} />
    case 'waiting':
      return (
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full bg-attention-dot', className)}
        />
      )
    case 'running':
      return <Spinner aria-hidden className={cn('size-3 shrink-0 text-info', className)} />
    case 'starting':
      // The app's own wait before the agent works, so it keeps a neutral spinner.
      return <Spinner aria-hidden className={cn('size-3 shrink-0 text-secondary', className)} />
    case 'cancelled':
    case 'interrupted':
    case 'skipped':
      return <CircleSlashIcon aria-hidden className={cn(common, 'text-tertiary')} />
    case 'queued':
      return <span aria-hidden className={cn(common, 'block')} />
  }
}
