import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MAX_HEIGHT_SHARE,
  setComposerHeight,
  useComposerHeight,
} from '@renderer/stores/composer-height'
import type { ComposerEditorHandle } from './editor'

// A key press moves the box this far, a Shift press four times as far.
const STEP = 24

interface Measure {
  height: number
  least: number
  most: number
}

/**
 * The handle on the box's top edge: drag it up or down to set the text's height, press Home or
 * double-click to let the box size itself again.
 */
export function ResizeGrip({ editor }: { editor: RefObject<ComposerEditorHandle | null> }) {
  const { t } = useTranslation('composer')
  // Where a drag started: the pointer's height and the box's, with the bounds measured then.
  const drag = useRef<{ y: number; start: Measure } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fixed = useComposerHeight((s) => s.height)

  const measure = (): Measure | null => {
    const measured = editor.current?.measure()
    if (!measured) return null
    const most = Math.max(measured.least, Math.floor(window.innerHeight * MAX_HEIGHT_SHARE))
    return { height: measured.height, least: measured.least, most }
  }
  const setHeight = (from: Measure, wanted: number) => {
    setComposerHeight(Math.round(Math.min(from.most, Math.max(from.least, wanted))))
  }

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const start = measure()
    if (!start) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, start }
    setDragging(true)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current) setHeight(current.start, current.start.height + current.y - event.clientY)
  }
  const up = () => {
    drag.current = null
    setDragging(false)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      setComposerHeight(null)
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const from = measure()
    if (!from) return
    const step = (event.shiftKey ? 4 : 1) * STEP
    setHeight(from, from.height + (event.key === 'ArrowUp' ? step : -step))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('resize.label')}
      // Only a height the user set has a value; an automatic one follows the text.
      aria-valuenow={fixed ?? undefined}
      tabIndex={0}
      className="kettu-prompt-grip"
      data-dragging={dragging || undefined}
      // Not a press on the writing area, which would put the caret in the text.
      data-composer-own=""
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => setComposerHeight(null)}
      onKeyDown={keyDown}
    />
  )
}
