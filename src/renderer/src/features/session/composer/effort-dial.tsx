import { useEffect, useId, useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { cn } from '@renderer/lib/utils'

/** A stop on the dial: an effort level, or the Default that leaves it to the agent. */
export interface DialStop {
  value: string
  name: string
  isDefault?: boolean
}

// The top of a large wheel. A level is 60 px apart at the mark, with four minor ticks between.
const SP = 60
const MINOR = 4
const H = 64
const TOP = 9
const STIFFNESS = 170
const DAMPING = 21
// How long a flick's speed carries on before the wheel settles.
const CARRY = 0.2

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const band = (x: number) => (1 - 1 / (x * 0.9 + 1)) * 0.5
const f = (v: number) => v.toFixed(2)
const radius = (w: number) => Math.max(220, w * 0.86)

interface Tick {
  lv: number
  major: boolean
  round: boolean
}

function ticksOf(n: number, auto: boolean): Tick[] {
  return Array.from({ length: (n - 1) * (MINOR + 1) + 1 }, (_, k) => ({
    lv: k / (MINOR + 1),
    major: k % (MINOR + 1) === 0,
    round: auto && k === 0,
  }))
}

interface Sample {
  t: number
  p: number
}

/** Levels per second over the last samples; none once the pointer rested more than 60 ms. */
function velocity(samples: readonly Sample[], at: number): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]!
  if (at - last.t > 60) return 0
  const first = samples[0]!
  const dt = (last.t - first.t) / 1000
  return dt < 0.01 ? 0 : clamp((last.p - first.p) / dt, -25, 25)
}

/** The level under a point of the dial, `pos` being the level at the mark. */
function levelAt(x: number, y: number, pos: number, w: number): number {
  const r = radius(w)
  return pos + Math.atan2(x - w / 2, r + TOP - y) / (SP / r)
}

/**
 * Effort as the top of a wheel under a fixed mark: a drag turns it 1:1, a flick carries on and
 * settles on the nearest level, a trackpad turns it continuously and a wheel notch steps one level.
 * The change is sent once the wheel settles; `onPreview` follows the level at the mark meanwhile.
 */
export function EffortDial({
  label,
  stops,
  value,
  onChange,
  onPreview,
  disabled = false,
  className,
  ...rest
}: {
  label: string
  stops: readonly DialStop[]
  value: string | undefined
  onChange: (value: string) => void
  /** The level at the mark while the wheel moves, then null once it settles. */
  onPreview?: (value: string | null) => void
  disabled?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'onChange'>) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const rootRef = useRef<HTMLDivElement>(null)
  const dialRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const latest = useRef({ stops, onChange, onPreview, disabled })
  useLayoutEffect(() => {
    latest.current = { stops, onChange, onPreview, disabled }
  })
  const engine = useRef<{ sync: (index: number) => void } | null>(null)

  const n = stops.length
  const auto = !!stops[0]?.isDefault
  const ticks = ticksOf(n, auto)
  // The engine is rebuilt only when the stops themselves change.
  const key = stops.map((s) => `${s.isDefault ? '*' : ''}${s.value}`).join('\n')
  const index = Math.max(
    0,
    stops.findIndex((s) => s.value === value),
  )

  useLayoutEffect(() => {
    const root = rootRef.current
    const dial = dialRef.current
    const svg = svgRef.current
    if (!root || !dial || !svg || n === 0) return
    const q = <T extends Element>(s: string) => svg.querySelector<T>(s)!
    const tickEls = [...svg.querySelectorAll<SVGElement>('.kettu-dial__tick')]
    const names = [...svg.querySelectorAll<SVGTextElement>('.kettu-dial__name')]
    const face = q<SVGCircleElement>('.kettu-dial__face')
    const rim = q<SVGCircleElement>('.kettu-dial__rim')
    const lens = q<SVGEllipseElement>('.kettu-dial__lens')
    const mark = q<SVGGElement>('.kettu-dial__mark')
    const lines = [...mark.querySelectorAll('line')]
    const tri = q<SVGPathElement>('.kettu-dial__tri')
    const first = auto ? 1 : 0

    const d = {
      pos: index,
      target: index,
      committed: index,
      shown: -1,
      mode: 'idle' as 'idle' | 'drag' | 'wheel',
      samples: [] as Sample[],
      moved: false,
      startX: 0,
      startPos: 0,
      raw: 0,
      w: 0,
      anim: null as AnimationPlaybackControls | null,
      wheelTimer: 0,
    }
    const rubber = (p: number) => (p < 0 ? -band(-p) : p > n - 1 ? n - 1 + band(p - n + 1) : p)
    const local = (e: PointerEvent): [number, number] => {
      const r = dial.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const announce = (i: number) => {
      const stop = latest.current.stops[i]
      if (!stop) return
      dial.setAttribute('aria-valuenow', String(i))
      dial.setAttribute('aria-valuetext', stop.name)
      latest.current.onPreview?.(stop.value)
    }

    const nameAt = (
      e: SVGTextElement,
      i: number,
      pos: number,
      x: number,
      y: number,
      rotate: number,
      alpha: number,
    ) => {
      const near = clamp(1 - Math.abs(i - pos), 0, 1)
      const s = 1 + 0.13 * near
      e.setAttribute('transform', `translate(${f(x)} ${f(y)}) rotate(${f(rotate)}) scale(${f(s)})`)
      e.style.opacity = f(alpha * (0.62 + 0.38 * near))
    }
    const shape = (pos: number) => {
      const w = d.w
      if (w <= 0) return
      const r = radius(w)
      const cx = w / 2
      const cy = r + TOP
      const step = SP / r
      const half = Math.asin(Math.min(1, w / 2 / r))
      const fade = (phi: number) => clamp(1 - (Math.abs(phi) / half) ** 4, 0, 1)
      const sink = (y: number, room: number) => clamp((H - y) / room, 0, 1)
      for (const c of [face, rim]) {
        c.setAttribute('cx', f(cx))
        c.setAttribute('cy', f(cy))
        c.setAttribute('r', f(r))
      }
      ticks.forEach((t, k) => {
        const e = tickEls[k]
        if (!e) return
        const phi = (t.lv - pos) * step
        if (Math.abs(phi) > half + 0.05) {
          e.style.opacity = '0'
          return
        }
        const sn = Math.sin(phi)
        const cs = Math.cos(phi)
        if (t.round) {
          const rr = r - 9
          e.setAttribute('cx', f(cx + rr * sn))
          e.setAttribute('cy', f(cy - rr * cs))
          e.setAttribute('r', '3.4')
        } else {
          const outer = r - 2
          const inner = outer - (t.major ? 13 : 6)
          e.setAttribute('x1', f(cx + outer * sn))
          e.setAttribute('y1', f(cy - outer * cs))
          e.setAttribute('x2', f(cx + inner * sn))
          e.setAttribute('y2', f(cy - inner * cs))
        }
        e.style.opacity = f(fade(phi) * sink(cy - (r - 15) * cs, 10))
        e.toggleAttribute('data-lit', t.lv >= first && t.lv <= pos + 0.001)
      })
      names.forEach((e, i) => {
        const phi = (i - pos) * step
        if (Math.abs(phi) > half + 0.05) {
          e.style.opacity = '0'
          return
        }
        const rr = r - 29
        const y = cy - rr * Math.cos(phi)
        nameAt(
          e,
          i,
          pos,
          cx + rr * Math.sin(phi),
          y,
          (phi * 180) / Math.PI,
          fade(phi) * sink(y + 7, 14),
        )
      })
      lens.setAttribute('cx', f(cx))
      for (const l of lines) {
        l.setAttribute('x1', f(cx))
        l.setAttribute('x2', f(cx))
        l.setAttribute('y1', '5')
        l.setAttribute('y2', '23')
      }
      tri.setAttribute('d', `M${f(cx - 4.5)},0L${f(cx + 4.5)},0L${f(cx)},5.5Z`)
    }
    // Restarts a CSS animation on an element that may still be running it.
    const replay = (e: Element, attr: string) => {
      e.removeAttribute(attr)
      void e.getBoundingClientRect()
      e.setAttribute(attr, '')
    }
    const draw = () => {
      shape(d.pos)
      const shown = clamp(Math.round(d.pos), 0, n - 1)
      if (shown === d.shown) return
      const passing = d.shown !== -1
      d.shown = shown
      names.forEach((e, i) => e.toggleAttribute('data-on', i === shown))
      if (d.mode !== 'idle') announce(shown)
      if (passing && !prefersReducedMotion()) {
        replay(mark, 'data-tick')
        const k = shown * (MINOR + 1)
        const tick = tickEls[k]
        if (tick && !ticks[k]?.round) replay(tick, 'data-flash')
      }
    }

    const settle = () => {
      d.anim = null
      const stop = latest.current.stops[d.target]
      if (stop && d.target !== d.committed) {
        d.committed = d.target
        latest.current.onChange(stop.value)
      }
      latest.current.onPreview?.(null)
    }
    const spring = (velocity: number) => {
      d.anim?.stop()
      if (prefersReducedMotion() || (d.pos === d.target && velocity === 0)) {
        d.anim = null
        d.pos = d.target
        draw()
        settle()
        return
      }
      d.anim = animate(d.pos, d.target, {
        type: 'spring',
        stiffness: STIFFNESS,
        damping: DAMPING,
        mass: 1,
        velocity,
        restDelta: 0.0005,
        restSpeed: 0.003,
        onUpdate: (p) => {
          d.pos = p
          draw()
        },
        onComplete: settle,
      })
    }
    const setTarget = (i: number, velocity = 0) => {
      window.clearTimeout(d.wheelTimer)
      d.target = clamp(Math.round(i), 0, n - 1)
      d.mode = 'idle'
      announce(d.target)
      spring(velocity)
    }

    const down = (e: PointerEvent) => {
      if (latest.current.disabled || e.button !== 0) return
      dial.setPointerCapture(e.pointerId)
      // A press catches a wheel that is still turning.
      d.anim?.stop()
      d.anim = null
      window.clearTimeout(d.wheelTimer)
      d.mode = 'drag'
      d.moved = false
      d.startX = e.clientX
      d.startPos = d.pos
      d.samples = [{ t: e.timeStamp, p: d.pos }]
      root.setAttribute('data-drag', '')
      dial.focus({ preventScroll: true })
      e.preventDefault()
    }
    const move = (e: PointerEvent) => {
      if (d.mode !== 'drag') {
        if (latest.current.disabled) return
        const [x, y] = local(e)
        const i = Math.round(levelAt(x, y, d.pos, d.w))
        names.forEach((el, j) => el.toggleAttribute('data-hover', j === i))
        return
      }
      const moves = e.getCoalescedEvents?.() ?? []
      for (const m of moves.length ? moves : [e]) {
        d.samples.push({ t: m.timeStamp, p: d.startPos - (m.clientX - d.startX) / SP })
      }
      const dx = e.clientX - d.startX
      if (Math.abs(dx) > 2) d.moved = true
      d.pos = rubber(d.startPos - dx / SP)
      while (d.samples.length > 2 && e.timeStamp - d.samples[0]!.t > 100) d.samples.shift()
      draw()
    }
    const release = (e: PointerEvent) => {
      if (d.mode !== 'drag') return
      root.removeAttribute('data-drag')
      if (!d.moved) {
        const [x, y] = local(e)
        setTarget(levelAt(x, y, d.pos, d.w))
        return
      }
      const v = velocity(d.samples, e.timeStamp)
      const inside = d.pos >= 0 && d.pos <= n - 1
      setTarget(clamp(d.pos + v * CARRY, 0, n - 1), inside ? v : v * 0.3)
    }
    const leave = () => names.forEach((e) => e.removeAttribute('data-hover'))
    const wheel = (e: WheelEvent) => {
      if (latest.current.disabled) return
      e.preventDefault()
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      // A mouse's notch moves one level; a trackpad's small deltas turn the wheel with the fingers.
      if (e.deltaMode !== 0 || Math.abs(delta) >= 40) {
        setTarget(d.target + Math.sign(delta))
        return
      }
      if (d.mode !== 'wheel') {
        d.anim?.stop()
        d.anim = null
        d.mode = 'wheel'
        d.raw = d.pos
        d.samples = []
      }
      d.raw += delta / SP
      d.pos = rubber(d.raw)
      draw()
      window.clearTimeout(d.wheelTimer)
      d.wheelTimer = window.setTimeout(() => setTarget(clamp(d.pos, 0, n - 1)), 90)
    }
    const keyDown = (e: KeyboardEvent) => {
      if (latest.current.disabled) return
      const steps: Record<string, number> = {
        ArrowRight: 1,
        ArrowUp: 1,
        ArrowLeft: -1,
        ArrowDown: -1,
      }
      if (e.key in steps) setTarget(d.target + steps[e.key]!)
      else if (e.key === 'Home') setTarget(0)
      else if (e.key === 'End') setTarget(n - 1)
      else return
      // The menu's own arrow keys move between its rows; on the dial they turn it.
      e.preventDefault()
      e.stopPropagation()
    }

    const layout = () => {
      d.w = dial.clientWidth
      svg.setAttribute('viewBox', `0 0 ${d.w} ${H}`)
      shape(d.pos)
    }
    const observer = new ResizeObserver(layout)
    observer.observe(dial)
    dial.addEventListener('pointerdown', down)
    dial.addEventListener('pointermove', move)
    dial.addEventListener('pointerup', release)
    dial.addEventListener('pointercancel', release)
    dial.addEventListener('pointerleave', leave)
    dial.addEventListener('wheel', wheel, { passive: false })
    dial.addEventListener('keydown', keyDown)
    const start = latest.current.stops[index]
    if (start) {
      dial.setAttribute('aria-valuenow', String(index))
      dial.setAttribute('aria-valuetext', start.name)
    }
    layout()
    draw()

    engine.current = {
      // A value that changed elsewhere, such as Alt+E, turns the wheel without sending it again.
      sync: (i) => {
        if (i === d.committed || d.mode !== 'idle') return
        d.committed = i
        d.target = i
        dial.setAttribute('aria-valuenow', String(i))
        dial.setAttribute('aria-valuetext', latest.current.stops[i]?.name ?? '')
        spring(0)
      },
    }
    return () => {
      engine.current = null
      observer.disconnect()
      dial.removeEventListener('pointerdown', down)
      dial.removeEventListener('pointermove', move)
      dial.removeEventListener('pointerup', release)
      dial.removeEventListener('pointercancel', release)
      dial.removeEventListener('pointerleave', leave)
      dial.removeEventListener('wheel', wheel)
      dial.removeEventListener('keydown', keyDown)
      window.clearTimeout(d.wheelTimer)
      d.anim?.stop()
      // A menu closed while the wheel still turns keeps the level it was turning to.
      if (d.mode !== 'idle') d.target = clamp(Math.round(d.pos), 0, n - 1)
      const kept = latest.current.stops[d.target]
      if (kept && d.target !== d.committed) latest.current.onChange(kept.value)
      latest.current.onPreview?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stops are `key`; `sync` follows `index`
  }, [key])

  useEffect(() => engine.current?.sync(index), [index, key])

  return (
    <div
      {...rest}
      ref={rootRef}
      className={cn('kettu-dial', className)}
      data-disabled={disabled ? '' : undefined}
    >
      <span className="kettu-dial__label" id={`${uid}-label`}>
        {label}
      </span>
      <div
        ref={dialRef}
        className="kettu-dial__dial"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${uid}-label`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-disabled={disabled || undefined}
        data-mm-nav=""
      >
        <svg ref={svgRef} className="kettu-dial__svg" height={H} aria-hidden>
          <defs>
            <linearGradient
              id={`${uid}-face`}
              gradientUnits="userSpaceOnUse"
              x1="0"
              x2="0"
              y1={TOP}
              y2={H}
            >
              <stop offset="0" className="kettu-dial__face-top" />
              <stop offset="1" className="kettu-dial__face-bottom" />
            </linearGradient>
            <radialGradient id={`${uid}-lens`}>
              <stop offset="0" className="kettu-dial__lens-in" />
              <stop offset="1" className="kettu-dial__lens-out" />
            </radialGradient>
          </defs>
          <circle className="kettu-dial__face" fill={`url(#${uid}-face)`} />
          <circle className="kettu-dial__rim" />
          <ellipse
            className="kettu-dial__lens"
            cy="18"
            rx="44"
            ry="26"
            fill={`url(#${uid}-lens)`}
          />
          {ticks.map((t, k) =>
            t.round ? (
              <circle key={k} className="kettu-dial__tick kettu-dial__tick--auto" />
            ) : (
              <line
                key={k}
                className={
                  t.major ? 'kettu-dial__tick kettu-dial__tick--major' : 'kettu-dial__tick'
                }
              />
            ),
          )}
          {stops.map((s) => (
            <text
              key={s.value}
              className={
                s.isDefault ? 'kettu-dial__name kettu-dial__name--auto' : 'kettu-dial__name'
              }
              textAnchor="middle"
            >
              {s.name}
            </text>
          ))}
          <g className="kettu-dial__mark">
            <line className="kettu-dial__halo" />
            <line className="kettu-dial__line" />
            <path className="kettu-dial__tri" />
          </g>
        </svg>
      </div>
    </div>
  )
}
