import { useRef, useState, type ReactNode } from 'react'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { tabSensors } from '@renderer/components/tab-sensors'
import { cn } from '@renderer/lib/utils'

// How far a pointer may travel during a held press that still counts as a click on the heading.
const PRESS_TRAVEL = 10

/**
 * Groups the user can drag into another order, each a `SortableGroup` inside, such as the
 * sidebar's folders. A group dropped outside the list goes back to its place.
 */
export function SortableList({
  onMove,
  onPress,
  className,
  children,
}: {
  className?: string
  onMove: (from: number, to: number) => void
  /** A press held long enough to pick a group up and let go where it began, as a click. */
  onPress?: (id: string) => void
  children: ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState(0)
  const dragEnded = (event: DragEndEvent) => {
    const source = event.operation.source ?? null
    if (event.canceled || !isSortable(source)) return
    const { initial, current } = event.operation.position
    if (source.index === source.initialIndex) {
      const travel = Math.hypot(current.x - initial.x, current.y - initial.y)
      if (event.nativeEvent?.type.startsWith('pointer') && travel < PRESS_TRAVEL) {
        onPress?.(String(source.id))
      }
      return
    }
    const box = list.current?.getBoundingClientRect()
    if (
      !box ||
      current.x < box.left ||
      current.x > box.right ||
      current.y < box.top ||
      current.y > box.bottom
    ) {
      // The groups' elements were moved while dragging; drawn afresh, they are back in place.
      setDrawn((count) => count + 1)
      return
    }
    onMove(source.initialIndex, source.index)
  }
  return (
    <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
      <div ref={list} key={drawn} className={cn('flex shrink-0 flex-col', className)}>
        {children}
      </div>
    </DragDropProvider>
  )
}

/** One group of a `SortableList`, picked up by the element `children` gives `handleRef`. */
export function SortableGroup({
  id,
  index,
  disabled,
  as: Tag = 'div',
  label,
  className,
  children,
}: {
  id: string
  index: number
  disabled: boolean
  as?: 'div' | 'section'
  label?: string
  className?: string
  children: (handleRef: (element: Element | null) => void) => ReactNode
}) {
  const { ref, handleRef, isDragging } = useSortable({ id, index, disabled })
  return (
    <Tag
      ref={ref}
      aria-label={label}
      className={className ?? 'kettu-side-sortable'}
      data-dragging={isDragging || undefined}
    >
      {children(handleRef)}
    </Tag>
  )
}
