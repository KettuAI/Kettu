import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ControlPoint } from '@shared/control'
import { Button } from '@renderer/components/ui/button'

/** Room the bubble keeps from the surface's sides and top. */
const EDGE = 8
/** The bubble's gap from the click, for its tip. */
const GAP = 14

/**
 * Where the user clicked while the agent used the surface: the click was held back, and Take over
 * is one click away. It sits above the click, or below it near the top, and keeps inside the
 * surface, its tip still on the click. `at` is in the pixels of the positioned box it sits in.
 */
export function HeldBubble({
  at,
  agentName,
  scope,
  leaving,
  onTakeOver,
}: {
  at: ControlPoint
  agentName: string
  /** What the user cannot use now, as the bubble names it: "this tab", "this device". */
  scope: string
  leaving?: boolean
  onTakeOver: () => void
}) {
  const { t } = useTranslation('control')
  const bubble = useRef<HTMLSpanElement>(null)

  // Placed from its own size before it paints, so it never shows outside the surface first.
  useLayoutEffect(() => {
    const element = bubble.current
    const surface = element?.offsetParent
    if (!element || !surface) return
    const half = element.offsetWidth / 2
    const room = surface.clientWidth
    const x = Math.min(Math.max(at.x, half + EDGE), Math.max(half + EDGE, room - half - EDGE))
    element.style.left = `${x}px`
    element.style.top = `${at.y}px`
    element.style.setProperty('--ctl-bubble-tip', `${at.x - x}px`)
    element.toggleAttribute('data-below', at.y < element.offsetHeight + GAP + EDGE)
  }, [at.x, at.y])

  return (
    <span ref={bubble} role="status" className="ctl-bubble" data-leaving={leaving ? '' : undefined}>
      <span className="ctl-bubble__text">
        <b>{t('bubble.title', { agent: agentName, scope })}</b>
        <span>{t('bubble.hint')}</span>
      </span>
      <Button size="dialog" onClick={onTakeOver}>
        {t('actions.takeOver')}
      </Button>
    </span>
  )
}
