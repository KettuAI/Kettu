import { useEffect, useRef, useState, type CSSProperties } from 'react'
import './edge-light.css'

/** How long the light takes to leave, as the stylesheet's exit runs. */
const EXIT_MS = 420
/** One swell where the agent acts. */
const SWELL_MS = 1100

/** Where the agent acted last, as shares of the surface; null where the action had no point. */
export interface EdgeLightAct {
  seq: number
  x: number | null
  y: number | null
}

/** Keeps the light drawn while it leaves. */
function usePresence(on: boolean, still: boolean): 'in' | 'out' | 'gone' {
  const [state, setState] = useState<'in' | 'out' | 'gone'>(on ? 'in' : 'gone')
  const [was, setWas] = useState(on)
  if (on !== was) {
    setWas(on)
    setState(on ? 'in' : still ? 'gone' : 'out')
  }
  useEffect(() => {
    if (state !== 'out') return
    const timer = setTimeout(() => setState('gone'), EXIT_MS)
    return () => clearTimeout(timer)
  }, [state])
  return state
}

/**
 * The light on what an agent uses in its turn: soft light along the edges in fox, amber, rose and
 * peach, turning once in 14 s, swelling where the agent acts. It means only that the agent is at
 * work there, so it shows only then. Inside runs along the inner edges of what fills its view;
 * outside rings what is shown as a thing, never over its content, taking `pad` around it. `wide`
 * is the stronger halo of a real window on the desktop, which must show on any wallpaper. The
 * parent is the surface: positioned, and the light covers it. Still under reduced motion.
 */
export function EdgeLight({
  on,
  place,
  radius,
  pad = 64,
  act,
  wide = false,
  still = false,
}: {
  on: boolean
  place: 'inside' | 'outside'
  radius: number
  pad?: number
  act?: EdgeLightAct | null
  wide?: boolean
  /** Reduced motion from the app's own setting; the system's is read by the stylesheet. */
  still?: boolean
}) {
  const presence = usePresence(on, still)
  const glow = useRef<HTMLSpanElement>(null)
  const core = useRef<HTMLSpanElement>(null)
  const seq = act?.seq ?? 0
  // An action from before the light came is not this light's to answer.
  const [firstSeq] = useState(seq)
  const swelled = useRef(seq)

  // Each action: the whole ring brightens and widens a little, then settles.
  useEffect(() => {
    if (seq === swelled.current) return
    swelled.current = seq
    if (presence !== 'in' || still || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)'
    for (const layer of [glow.current, core.current]) {
      layer?.animate([{ opacity: 1, transform: 'scale(1.008)', offset: 0.16 }], {
        duration: SWELL_MS,
        easing,
      })
    }
  }, [seq, presence, still])

  if (presence === 'gone') return null
  const style = {
    '--edge-light-r': `${radius}px`,
    '--edge-light-pad': `${pad}px`,
    ...(act && act.x !== null && act.y !== null
      ? { '--edge-light-x': `${act.x * 100}%`, '--edge-light-y': `${act.y * 100}%` }
      : {}),
  } as CSSProperties
  return (
    <span
      aria-hidden
      className="edge-light"
      data-place={place}
      data-wide={wide || undefined}
      data-out={presence === 'out' || undefined}
      data-still={still || undefined}
      style={style}
    >
      <span ref={glow} className="edge-light__glow">
        <span className="edge-light__ring">
          <i className="edge-light__turn" />
        </span>
      </span>
      <span ref={core} className="edge-light__core">
        <span className="edge-light__ring">
          <i className="edge-light__turn" />
        </span>
      </span>
      <span className="edge-light__rim">
        <span className="edge-light__ring">
          <i className="edge-light__turn" />
        </span>
      </span>
      {seq !== firstSeq && presence === 'in' && !still && (
        <span key={seq} className="edge-light__flare">
          <i />
        </span>
      )}
    </span>
  )
}
