import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

interface Measured {
  el: HTMLElement
  setHeight: (height: number) => void
}

const measuredBy = new Map<Element, Measured>()
let sharedObserver: ResizeObserver | null = null

/**
 * One observer for every Clamp. Its callback runs after layout and before paint: it reads every
 * changed height while the layout is clean, then commits them in one synchronous render, so a
 * mount forces no layout of its own and the first paint is already clamped. Measuring in each
 * Clamp's layout effect instead laid out the whole thread once per commit of a long history.
 */
function observer(): ResizeObserver {
  sharedObserver ??= new ResizeObserver((entries) => {
    const changed = new Set<Measured>()
    for (const entry of entries) {
      const measured = measuredBy.get(entry.target)
      if (measured) changed.add(measured)
    }
    const heights = [...changed].map((m) => [m, m.el.scrollHeight] as const)
    flushSync(() => {
      for (const [m, height] of heights) m.setHeight(height)
    })
  })
  return sharedObserver
}

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
    const measured = { el, setHeight }
    // The children too: the clamped box itself stops growing at its max-height.
    const targets = [el, ...el.children]
    for (const target of targets) {
      measuredBy.set(target, measured)
      observer().observe(target)
    }
    return () => {
      for (const target of targets) {
        observer().unobserve(target)
        measuredBy.delete(target)
      }
    }
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
