import { CheckIcon, RefreshCwIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import type { RefreshPhase } from './refresh'

/** A refresh button's own icon: it turns while the work runs, then shows a check if it worked. */
export function RefreshIcon({
  phase,
  className,
  ...props
}: { phase: RefreshPhase } & React.ComponentProps<typeof RefreshCwIcon>) {
  if (phase === 'done') return <CheckIcon className={className} {...props} />
  return (
    <RefreshCwIcon className={cn(phase === 'turning' && 'animate-spin', className)} {...props} />
  )
}
