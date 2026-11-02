import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { count, exactCount, usd } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type { MetricKind } from './model'

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

/** A figure in the metric: a compact count, or US dollars. */
export function FigureValue({
  value,
  kind,
  className,
}: {
  value: number
  kind: MetricKind
  className?: string
}) {
  return kind === 'cost' ? (
    <span className={cn('tabular-nums', className)}>{usd(value)}</span>
  ) : (
    <Count value={value} className={className} />
  )
}
