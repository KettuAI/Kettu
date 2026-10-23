import { useRef, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'

/** A one-line label that truncates, with its full text in a tooltip only while it is cut. */
export function CutLabel({
  className,
  full,
  children,
}: {
  className?: string
  full: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const label = ref.current
        setOpen(next && !!label && label.scrollWidth > label.clientWidth)
      }}
    >
      <TooltipTrigger render={<span ref={ref} className={className} />}>{children}</TooltipTrigger>
      {/* One span, so the popup's flex row does not set each part in a column of its own. */}
      <TooltipContent>
        <span>{full}</span>
      </TooltipContent>
    </Tooltip>
  )
}
