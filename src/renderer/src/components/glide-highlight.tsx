import { useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { glide } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'

/** Where the highlight sits; `glides` is false when it appears rather than moves from a row. */
type Box = { x: number; y: number; width: number; height: number; glides: boolean }

/**
 * One highlight for a list's rows that glides to whichever row Base UI marks `data-highlighted`.
 * Place it as the first child of the positioned element the rows scroll in; the rows then draw no
 * highlight of their own.
 */
export function GlideHighlight({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<Box | null>(null)

  useLayoutEffect(() => {
    const list = ref.current?.parentElement
    if (!list) return
    const measure = () => {
      const row = list.querySelector<HTMLElement>('[data-highlighted]')
      if (!row) {
        setBox(null)
        return
      }
      // Offsets, not client rects: the popup's zoom-in on open would scale a rect's distances.
      let x = 0
      let y = 0
      let at: Element | null = row
      while (at instanceof HTMLElement && at !== list) {
        x += at.offsetLeft
        y += at.offsetTop
        at = at.offsetParent
      }
      if (at !== list) return
      setBox((last) => ({
        x,
        y,
        width: row.offsetWidth,
        height: row.offsetHeight,
        glides: last !== null,
      }))
    }
    measure()
    const observer = new MutationObserver(measure)
    observer.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-highlighted'],
    })
    return () => observer.disconnect()
  }, [])

  return (
    <motion.span
      ref={ref}
      aria-hidden
      initial={false}
      animate={box ? { x: box.x, y: box.y, opacity: 1 } : { opacity: 0 }}
      transition={box?.glides ? glide : { duration: box ? 0 : 0.1 }}
      style={box ? { width: box.width, height: box.height } : undefined}
      className={cn('pointer-events-none absolute top-0 left-0 rounded-lg bg-selected', className)}
    />
  )
}
