import { InformationCircleIcon, StopCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { StopReason } from '@shared/thread'
import { cn } from '@renderer/lib/utils'
import { turnEndTagText } from './turn-end'

/**
 * How a turn ended, as a muted line: an icon, the reason and, past a second, the turn's time. A
 * turn that ended on its own already says its time, and has no icon.
 */
export function TurnEndTag({
  stopReason,
  durationMs,
  className,
}: {
  stopReason: StopReason
  durationMs: number
  className?: string
}) {
  useTranslation('session')
  const text = turnEndTagText(stopReason, durationMs)
  if (text === null) return null
  return (
    <span
      className={cn(
        'flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular',
        className,
      )}
    >
      {stopReason !== 'end_turn' && (
        <HugeiconsIcon
          icon={stopReason === 'cancelled' ? StopCircleIcon : InformationCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.5 shrink-0"
        />
      )}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  )
}
