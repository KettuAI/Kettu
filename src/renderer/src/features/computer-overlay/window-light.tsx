import type { ComputerOverlayState } from '@shared/computer-overlay'
import { EdgeLight } from '@renderer/components/edge-light/edge-light'

/** The real window's corner: macOS draws its windows rounder than Windows and Linux do. */
const RADIUS = window.kettu.platform === 'darwin' ? 14 : 8

/**
 * The light and the agent's pointer around the real window, in a window that lets every click
 * through and sits just above it. The page is the window plus the room the light takes.
 */
export function WindowLight({ state }: { state: ComputerOverlayState }) {
  const { frame, act, control } = state
  if (!frame) return null
  const point = act && act.x !== null && act.y !== null ? act : null
  return (
    <div
      className="kco-target"
      style={{ left: frame.pad, top: frame.pad, width: frame.width, height: frame.height }}
    >
      <EdgeLight
        on={control === 'agent'}
        place={frame.inside ? 'inside' : 'outside'}
        radius={frame.inside ? 0 : RADIUS}
        pad={frame.pad}
        act={act}
        wide
        still={state.reduceMotion}
      />
      {control === 'agent' && point && (
        <AgentPointer
          x={point.x! * frame.width}
          y={point.y! * frame.height}
          click={act?.kind === 'click' ? act.seq : 0}
          name={state.agentName}
        />
      )}
    </div>
  )
}

/** The agent's pointer: it glides to where its next action lands and rings where it clicks. */
function AgentPointer({
  x,
  y,
  click,
  name,
}: {
  x: number
  y: number
  click: number
  name: string
}) {
  return (
    <span aria-hidden className="kco-pointer" style={{ transform: `translate(${x}px, ${y}px)` }}>
      {click > 0 && <span key={click} className="kco-pointer__ring" />}
      <svg viewBox="0 0 16 16" width="19" height="19" className="kco-pointer__mark">
        <path d="M2.5 1.8l10.4 6.1-4.6 1.1-2.3 4.3z" />
      </svg>
      <span className="kco-pointer__name">{name}</span>
    </span>
  )
}
