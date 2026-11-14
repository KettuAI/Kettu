import type { ControlPoint } from '@shared/control'
import { AgentCursorStyles, AgentPointer } from '@renderer/components/affect/agent-cursors'

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
  return (
    <div className="ctl-pointer ui-agc" aria-hidden>
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
