import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { count, exactCount } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

/** A count, compact, with the exact value in its tooltip. */
export function Count({ value, className }: { value: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('tabular-nums', className)} />}>
        {count(value)}
      </TooltipTrigger>
      <TooltipContent>{exactCount(value)}</TooltipContent>
    </Tooltip>
  )
}
