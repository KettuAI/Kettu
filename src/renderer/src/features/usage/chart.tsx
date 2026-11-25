// The tooltip of the usage page's charts, over the point under the pointer, and its rows.

import { useMemo, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent } from '@renderer/components/ui/tooltip'

/**
 * The app's tooltip over a point of a chart, a rectangle in the window's coordinates; it keeps the
 * last point while it closes.
 */
export function ChartTip({ at, children }: { at: DOMRect | null; children: ReactNode }) {
  const [last, setLast] = useState(at)
  if (at && at !== last) setLast(at)
  const shown = at ?? last
  const anchor = useMemo(() => shown && { getBoundingClientRect: () => shown }, [shown])
  return (
    <Tooltip open={at !== null}>
      <TooltipContent anchor={anchor} side="top" sideOffset={6} className="k-u-tip">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

/** A row of a chart's tooltip: a swatch, a name and its amount. */
export function TipRow({
  color,
  label,
  value,
  strong = false,
}: {
  color?: string
  label: ReactNode
  value: ReactNode
  strong?: boolean
}) {
  return (
    <span className="k-u-tip__row" data-strong={strong || undefined}>
      {color && <i style={{ background: color }} />}
      <span>{label}</span>
      <b className="k-num">{value}</b>
    </span>
  )
}
