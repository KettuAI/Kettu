import { useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { glide } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'

/**
 * Where the highlight sits, with `clip` the part of it that stays visible; `glides` is false when
 * it appears rather than moves from a row.
 */
type Box = {
  x: number
  y: number
  width: number
  height: number
  clip: string | null
  glides: boolean
}

type Edges = { left: number; top: number; right: number; bottom: number }

// How far a side of the clip may lie outside the highlight, so a shadow is not cut.
const OPEN = 100

/** Where `el` lies in `list`, as if nothing between them scrolled; null if not inside it. */
function offsetsIn(list: HTMLElement, el: HTMLElement): { x: number; y: number } | null {
  let x = 0
  let y = 0
  let at: Element | null = el
  while (at instanceof HTMLElement && at !== list) {
    x += at.offsetLeft
    y += at.offsetTop
    at = at.offsetParent
  }
  return at === list ? { x, y } : null
}

/** Where `el` is seen in `list`: its offsets less what the scrolled elements between them hide. */
function placeIn(list: HTMLElement, el: HTMLElement): { x: number; y: number } | null {
  const at = offsetsIn(list, el)
  if (!at) return null
  for (let up = el.parentElement; up && up !== list; up = up.parentElement) {
    at.x -= up.scrollLeft
    at.y -= up.scrollTop
  }
  return at
}

/**
 * What the scrolling elements between `list` and `row` leave of `list` to see the row in; a side
 * no element cuts stays at infinity.
 */
function visibleEdges(list: HTMLElement, row: HTMLElement): Edges {
  const edges = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
  for (let up = row.parentElement; up && up !== list; up = up.parentElement) {
    const across = up.scrollWidth > up.clientWidth
    const down = up.scrollHeight > up.clientHeight
    if (!across && !down) continue
    const style = getComputedStyle(up)
    const at = placeIn(list, up)
    if (!at) continue
    if (across && style.overflowX !== 'visible') {
      edges.left = Math.max(edges.left, at.x + up.clientLeft)
      edges.right = Math.min(edges.right, at.x + up.clientLeft + up.clientWidth)
    }
    if (down && style.overflowY !== 'visible') {
      edges.top = Math.max(edges.top, at.y + up.clientTop)
      edges.bottom = Math.min(edges.bottom, at.y + up.clientTop + up.clientHeight)
    }
  }
  return edges
}

/**
 * One highlight for a list's rows that glides to whichever row Base UI marks `data-highlighted`.
 * Place it as the first child of the positioned element the rows scroll in; the rows then draw no
 * highlight of their own. Rows may also scroll in containers of their own inside that element: the
 * highlight follows them and is cut where their rows are.
 */
export function GlideHighlight({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<Box | null>(null)

  useLayoutEffect(() => {
    const list = ref.current?.parentElement
    if (!list) return
    // `glides` is false for a scroll, which moves the row under the highlight, not to another row.
    const measure = (glides: boolean) => {
      const row = list.querySelector<HTMLElement>('[data-highlighted]')
      if (!row) {
        setBox(null)
        return
      }
      // Offsets, not client rects: the popup's zoom-in on open would scale a rect's distances.
      const at = placeIn(list, row)
      if (!at) return
      const { x, y } = at
      const width = row.offsetWidth
      const height = row.offsetHeight
      const edges = visibleEdges(list, row)
      const cut = [edges.left, edges.top, edges.right, edges.bottom].some(Number.isFinite)
      const inset = (distance: number) => `${Math.max(-OPEN, distance)}px`
      const clip = cut
        ? `inset(${inset(edges.top - y)} ${inset(x + width - edges.right)} ${inset(y + height - edges.bottom)} ${inset(edges.left - x)})`
        : null
      setBox((last) =>
        last &&
        last.x === x &&
        last.y === y &&
        last.width === width &&
        last.height === height &&
        last.clip === clip
          ? last
          : { x, y, width, height, clip, glides: glides && last !== null },
      )
    }
    const place = () => measure(true)
    const follow = (event: Event) => {
      if (event.target !== list) measure(false)
    }
    place()
    const observer = new MutationObserver(place)
    observer.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-highlighted'],
    })
    // A scroll does not bubble, so a container inside the list is heard in the capture phase.
    list.addEventListener('scroll', follow, true)
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', follow, true)
    }
  }, [])

  return (
    <motion.span
      ref={ref}
      aria-hidden
      initial={false}
      animate={
        box ? { x: box.x, y: box.y, opacity: 1, clipPath: box.clip ?? 'none' } : { opacity: 0 }
      }
      transition={box?.glides ? glide : { duration: box ? 0 : 0.1 }}
      style={box ? { width: box.width, height: box.height } : undefined}
      className={cn('pointer-events-none absolute top-0 left-0 rounded-lg bg-selected', className)}
    />
  )
}
