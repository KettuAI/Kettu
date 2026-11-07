// The small mark a run shows before its time; the row's words say the same.

import { Cancel01Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons'
import type { RunStatus } from '@shared/routines'
import { Icon } from '@renderer/components/affect/app-shell'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { cn } from '@renderer/lib/utils'

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

export function RunMark({ status }: { status: RunStatus }) {
  switch (status) {
    case 'succeeded':
      return <Icon icon={CheckmarkCircle02Icon} size={14} />
    case 'failed':
    case 'timed_out':
      return <Icon icon={Cancel01Icon} size={14} />
    case 'waiting':
      return <span aria-hidden className="k-rs__dot" />
    case 'running':
      // A turn's dot matrix, as the session's own status line shows its agent at work.
      return <TurnDots phase="working" />
    case 'starting':
      // The app's own wait before the agent works, so it keeps a neutral spinner.
      return <RingSpinner aria-hidden />
    case 'cancelled':
    case 'interrupted':
    case 'skipped':
      return <span aria-hidden className="k-run__skip" />
    case 'queued':
      return null
  }
}
