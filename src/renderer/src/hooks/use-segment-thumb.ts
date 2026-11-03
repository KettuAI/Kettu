import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'

export interface SegmentBox {
  x: number
  width: number
}

/** A segmented control's own segments, or a menu's radio items laid out as segments. */
const SEGMENTS = ':scope > [data-slot=toggle-group-item], :scope > [role=menuitemradio]'

const segmentsOf = (group: HTMLElement): HTMLElement[] => [
  ...group.querySelectorAll<HTMLElement>(SEGMENTS),
]

/**
 * The thumb of a row of segments: where it sits, measured from the segments' boxes, and the
 * press and drag that moves it segment by segment and picks the one under the pointer on release.
 * `index` is the chosen segment's; spread `handlers` on the track, which `group` refers to.
 */
export function useSegmentThumb(index: number, count: number, pick: (index: number) => void) {
  const group = useRef<HTMLDivElement>(null)
  // The segment under the pointer while it is pressed.
  const [pressed, setPressed] = useState<number | null>(null)
  const [box, setBox] = useState<SegmentBox | null>(null)
  // The first placement is not animated, so the thumb never slides in from the track's edge.
  const [placed, setPlaced] = useState(false)
  const active = pressed ?? index

  useLayoutEffect(() => {
    const el = group.current
    if (!el) return
    const measure = () => {
      const item = segmentsOf(el)[active]
      if (!item) return setBox(null)
      // offsetLeft and offsetWidth round to whole pixels, and rects carry the transforms of
      // ancestors such as a menu zooming in, so rects are scaled back to the group's layout width.
      const group = el.getBoundingClientRect()
      const rect = item.getBoundingClientRect()
      const scale = group.width / parseFloat(getComputedStyle(el).width) || 1
      const x = (rect.left - group.left) / scale - el.clientLeft
      const width = rect.width / scale
      setBox((b) =>
        b && Math.abs(b.x - x) < 0.01 && Math.abs(b.width - width) < 0.01 ? b : { x, width },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const item of segmentsOf(el)) observer.observe(item)
    return () => observer.disconnect()
  }, [active, count])

  useLayoutEffect(() => {
    if (!box || placed) return
    const frame = requestAnimationFrame(() => setPlaced(true))
    return () => cancelAnimationFrame(frame)
  }, [box, placed])

  const segmentAt = (clientX: number): number => {
    const items = group.current ? segmentsOf(group.current) : []
    let nearest = Math.max(0, index)
    let distance = Infinity
    items.forEach((item, i) => {
      const r = item.getBoundingClientRect()
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      if (d < distance) {
        distance = d
        nearest = i
      }
    })
    return nearest
  }

  // With the pointer captured, the click lands on the track rather than a segment, so these
  // handlers alone choose by pointer; the keyboard still goes through the segments.
  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      setPressed(segmentAt(event.clientX))
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (pressed === null) return
      const at = segmentAt(event.clientX)
      if (at !== pressed) setPressed(at)
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      if (pressed === null) return
      setPressed(null)
      const at = segmentAt(event.clientX)
      if (at !== index) pick(at)
    },
    onPointerCancel: () => setPressed(null),
  }

  const thumb = { box: active >= 0 ? box : null, placed, pressed: pressed !== null }
  return { group, active, handlers, thumb }
}
