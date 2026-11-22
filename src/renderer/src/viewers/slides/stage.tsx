import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

/** Fills its box with a slide of `size`, scaled to fit and centred. */
export function Stage({
  size,
  children,
  className,
  framed = false,
}: {
  size: { width: number; height: number }
  children: ReactNode
  className?: string
  /** Sets the slide off from the canvas around it, when it does not fill the frame. */
  framed?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const fit = () =>
      setScale(Math.min(element.clientWidth / size.width, element.clientHeight / size.height))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [size.width, size.height])
  // The padding is outside the measured box, so the slide fits inside it.
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1', className)}>
      <div ref={box} className="relative grid min-h-0 min-w-0 flex-1 place-items-center">
        <div
          className={cn('overflow-hidden', framed && 'rounded-sm shadow-card')}
          style={{ width: size.width * scale, height: size.height * scale }}
        >
          <div
            className="origin-top-left"
            style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
