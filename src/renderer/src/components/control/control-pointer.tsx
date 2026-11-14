import { useLayoutEffect, useRef } from 'react'
import type { ControlPoint } from '@shared/control'
import { AgentCursorStyles, AgentPointer } from '@renderer/components/affect/agent-cursors'

/** The flag's gap from the pointer and from the surface's edge. */
const FLAG_GAP = 14

/**
 * The agent's pointer on a surface, affectUI's pointer with its name in the fox: it glides to where
 * each action lands and rings where it clicks. It fills the positioned box it sits in, whose
 * pixels `at` is in; `click` changes with each click to ring again.
 */
export function ControlPointer({
  id,
  name,
  at,
  click,
}: {
  /** What keys the pointer, such as the session. */
  id: string
  name: string
  at: ControlPoint
  click: number
}) {
  const box = useRef<HTMLDivElement>(null)

  // Near the right edge the name goes to the pointer's left, so it stays on the surface.
  useLayoutEffect(() => {
    const element = box.current
    const flag = element?.querySelector<HTMLElement>('.ui-agc__flag')
    if (!element || !flag) return
    const width = flag.offsetWidth
    const fits = at.x + FLAG_GAP + width + FLAG_GAP <= element.clientWidth
    element.style.setProperty('--ui-agc-shift', fits ? '0px' : `${-(width + 2 * FLAG_GAP)}px`)
  }, [at.x, name])

  return (
    <div ref={box} className="ctl-pointer ui-agc" aria-hidden>
      <AgentCursorStyles />
      <AgentPointer agent={{ id, name, color: 'var(--pane-fox)' }} x={at.x} y={at.y} doing={null} />
      {click > 0 && (
        <span
          key={click}
          className="ctl-pointer__ring"
          style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
        />
      )}
    </div>
  )
}
