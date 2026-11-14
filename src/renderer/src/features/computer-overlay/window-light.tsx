import { AnimatePresence } from 'motion/react'
import type { ComputerOverlayState } from '@shared/computer-overlay'
import { ControlPointer } from '@renderer/components/control/control-pointer'
import { SurfaceLight } from '@renderer/components/control/surface-light'

/** The real window's corner: macOS draws its windows rounder than Windows and Linux do. */
const RADIUS = window.kettu.platform === 'darwin' ? 14 : 8

/**
 * The light and the agent's pointer around the real window, in a window that lets every click
 * through and sits just above it. The page is the window plus the room the light takes; a window
 * that fills its screen takes the light along its inner edges.
 */
export function WindowLight({ state }: { state: ComputerOverlayState }) {
  const { frame, act, control } = state
  if (!frame) return null
  const agent = control === 'agent'
  const at =
    act && act.x !== null && act.y !== null
      ? { x: act.x * frame.width, y: act.y * frame.height }
      : null
  return (
    <div
      className="kco-target"
      data-wide={frame.inside ? undefined : ''}
      style={{ left: frame.pad, top: frame.pad, width: frame.width, height: frame.height }}
    >
      <AnimatePresence>
        {agent && (
          <SurfaceLight
            key="light"
            placement={frame.inside ? 'inside' : 'outside'}
            act={act?.seq ?? 0}
            at={at}
            radius={frame.inside ? 0 : RADIUS}
          />
        )}
      </AnimatePresence>
      {agent && at && (
        <ControlPointer
          id="agent"
          name={state.agentName}
          at={at}
          click={act?.kind === 'click' ? act.seq : 0}
        />
      )}
    </div>
  )
}
