import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/**
 * Content cut at a height behind a fade, with a button that shows the rest. The height animates
 * like a disclosure. A little slack keeps content just over the limit from hiding two lines.
 */
export function Clamp({
  maxHeight,
  more,
  less = 'Show less',
  children,
  className,
  buttonClassName,
}: {
  maxHeight: number
  more: string
  less?: string
  children: ReactNode
  className?: string
  buttonClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setHeight(el.scrollHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => observer.disconnect()
  }, [])

  const tall = height > maxHeight + 24
  const clamped = tall && !open
  return (
    <>
      <div
        ref={ref}
        className={cn(
          'overflow-hidden transition-[max-height] duration-(--duration-base) ease-out-expo motion-reduce:transition-none',
          clamped && 'mask-b-from-[calc(100%-56px)] mask-b-to-100%',
          className,
        )}
        style={{ maxHeight: clamped ? maxHeight : tall ? height : undefined }}
      >
        {children}
      </div>
      {tall && (
        <Button
          variant="quiet"
          size="xs"
          aria-expanded={open}
          className={cn('self-start', buttonClassName)}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? less : more}
        </Button>
      )}
    </>
  )
}
