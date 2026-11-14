import { useEffect, useRef, type CSSProperties, type Ref } from 'react'
import { motion } from 'motion/react'
import type { ControlPoint } from '@shared/control'
import { prefersReducedMotion } from '@renderer/stores/settings'

/** One part of the light: a ring along the edge, its colors turning on a layer of their own. */
function Ring({ part, ref }: { part: string; ref?: Ref<HTMLSpanElement> }) {
  return (
    <span ref={ref} className={`ctl-light__part ctl-light__${part}`}>
      <span className="ctl-light__ring">
        <span className="ctl-light__spin" />
      </span>
    </span>
  )
}

/**
 * The light on what an agent is using, in this turn: soft light along the edges in fox, amber and
 * rose, turning slowly, that swells and flares where the agent acts. It means that alone: asking
 * the user, a takeover and the turn's end put it out, so the caller shows it in an
 * `AnimatePresence` only while the agent has the surface.
 *
 * `inside` draws it along the inner edge of the positioned box it fills, such as a page; `outside`
 * around it and behind it, for a thing Kettu shows whose content it must not cover, such as a
 * phone or an app's window. `act` changes with each action, `at` is where it landed in the box's
 * pixels, and `radius` is the box's corner radius.
 */
export function SurfaceLight({
  placement = 'inside',
  act = 0,
  at = null,
  radius = 12,
}: {
  placement?: 'inside' | 'outside'
  act?: number
  at?: ControlPoint | null
  radius?: number
}) {
  const glow = useRef<HTMLSpanElement>(null)
  const core = useRef<HTMLSpanElement>(null)

  // Each action swells the light for a moment, from where it rests and back.
  useEffect(() => {
    if (!act || prefersReducedMotion()) return
    for (const part of [glow.current, core.current]) {
      part?.animate([{ opacity: 1, offset: 0.16 }], {
        duration: 1100,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      })
    }
  }, [act])

  const style = {
    '--ctl-light-r': `${radius}px`,
    '--ctl-light-x': at ? `${at.x}px` : '50%',
    '--ctl-light-y': at ? `${at.y}px` : '50%',
  } as CSSProperties
  return (
    <motion.span
      aria-hidden
      className="ctl-light"
      data-place={placement}
      style={style}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.56, ease: [0.22, 1, 0.36, 1] } }}
      exit={{ opacity: 0, transition: { duration: 0.42, ease: 'easeIn' } }}
    >
      <Ring part="glow" ref={glow} />
      <Ring part="core" ref={core} />
      <Ring part="rim" />
      {act > 0 && (
        <span key={act} className="ctl-light__part ctl-light__flare">
          <span className="ctl-light__ring" />
        </span>
      )}
    </motion.span>
  )
}
