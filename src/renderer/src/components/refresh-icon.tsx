import { RefreshIcon as RefreshGlyph, Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { cn } from '@renderer/lib/utils'
import type { RefreshPhase } from './refresh'

/** A refresh button's own icon: it turns while the work runs, then shows a check if it worked. */
export function RefreshIcon({ phase, className }: { phase: RefreshPhase; className?: string }) {
  if (phase === 'done') {
    return <HugeiconsIcon icon={Tick02Icon} strokeWidth={1.9} aria-hidden className={className} />
  }
  return (
    <HugeiconsIcon
      icon={RefreshGlyph}
      strokeWidth={1.9}
      aria-hidden
      className={cn(phase === 'turning' && 'animate-spin', className)}
    />
  )
}
