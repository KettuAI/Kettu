import { CircleAlertIcon } from 'lucide-react'
import type { AgentStatus } from '@shared/agent-host'
import { readiness } from './readiness'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'

/** A short status with its dot or icon: "Ready", "Sign in to start", "Installing…". */
export function AgentStateLine({ status, className }: { status: AgentStatus; className?: string }) {
  const r = readiness(status)
  const base = cn('inline-flex items-center gap-1.5 text-xs', className)
  switch (r.kind) {
    case 'ready':
      return (
        <span className={base}>
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          Ready
        </span>
      )
    case 'sign-in':
      return (
        <span className={cn(base, 'text-attention-text')}>
          <span aria-hidden className="size-1.5 rounded-full bg-attention" />
          Sign in to start
        </span>
      )
    case 'installing':
    case 'starting':
    case 'restarting':
      return (
        <span className={cn(base, 'text-muted-foreground')}>
          <Spinner className="size-3" />
          {r.kind === 'installing'
            ? 'Installing…'
            : r.kind === 'starting'
              ? 'Starting…'
              : 'Restarting…'}
        </span>
      )
    case 'failed':
      return (
        <span className={cn(base, 'text-destructive')}>
          <CircleAlertIcon strokeWidth={2} className="size-3.5" />
          Failed
        </span>
      )
    case 'missing':
      return <span className={cn(base, 'text-muted-foreground')}>Not available</span>
  }
}
