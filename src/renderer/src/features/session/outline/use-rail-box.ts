import { useEffect, useState, type RefObject } from 'react'
import { hasRailRoom } from './rail'

export interface RailBox {
  height: number
  room: boolean
}

/**
 * Measures the viewport's height and whether the thread column leaves enough room on the left for
 * the outline rail, re-measuring whenever either the viewport or the content column resizes.
 */
export function useRailBox(
  viewport: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): RailBox {
  const [box, setBox] = useState<RailBox>({ height: 0, room: false })
  useEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    const measure = (): void => {
      const inset = Number.parseFloat(getComputedStyle(column).paddingLeft) || 0
      const columnLeft = column.getBoundingClientRect().left - view.getBoundingClientRect().left
      const next: RailBox = { height: view.clientHeight, room: hasRailRoom(columnLeft, inset) }
      setBox((current) =>
        current.height === next.height && current.room === next.room ? current : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    observer.observe(column)
    return () => observer.disconnect()
  }, [viewport, content])
  return box
}
