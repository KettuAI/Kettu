import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent,
} from 'react'
import { AnimatePresence, MotionConfig } from 'motion/react'
import { useTranslation } from 'react-i18next'
import {
  HELD_BUBBLE_MS,
  OVERLAY_PILL_BOTTOM,
  OVERLAY_PILL_ROOM,
  type ControlOverlayApi,
  type ControlOverlayState,
  type ControlPoint,
} from '@shared/control'
import { ControlPointer } from '@renderer/components/control/control-pointer'
import { HeldBubble } from '@renderer/components/control/held-bubble'
import { SurfaceLight } from '@renderer/components/control/surface-light'
import { SurfacePill } from '@renderer/components/control/surface-pill'
import { useSettingsStore } from '@renderer/stores/settings'

const overlay = (window.kettu as unknown as ControlOverlayApi).overlay

/** How long the bubble takes to leave. */
const BUBBLE_LEAVE_MS = 200
/** The largest wheel step main takes. */
const MAX_WHEEL = 10_000
/** The clicks whose rings may still show. */
const KEPT_CLICKS = 4

/** The page over a surface an agent uses, in the overlay main stacks on it. */
export function OverlayRoot() {
  const reduceMotion = useSettingsStore((s) => s.settings.appearance.reduceMotion)
  return (
    <MotionConfig reducedMotion={reduceMotion === 'always' ? 'always' : 'user'}>
      <OverlayPage />
    </MotionConfig>
  )
}

interface Bubble {
  id: number
  at: ControlPoint
  leaving: boolean
}

/**
 * While the agent has the surface it covers all of it: the light along its edges, the agent's
 * pointer, the pill, and a bubble where a click was held back; the wheel goes through. While the
 * user has it, main sizes the overlay to the pill alone.
 */
function OverlayPage() {
  const { t } = useTranslation('control')
  const [state, setState] = useState<ControlOverlayState | null>(null)
  const [act, setAct] = useState<{ count: number; at: ControlPoint | null }>({
    count: 0,
    at: null,
  })
  const [pointer, setPointer] = useState<{ at: ControlPoint; clicks: number } | null>(null)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [clicks, setClicks] = useState<{ id: number; at: ControlPoint }[]>([])
  const [nudge, setNudge] = useState(0)
  const current = useRef<ControlOverlayState | null>(null)
  const sequence = useRef(0)
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wheel = useRef<{ x: number; y: number; deltaX: number; deltaY: number } | null>(null)

  /** A click or key the agent's turn held back: the pill bobs, and a click gets the bubble. */
  const held = useCallback((at: ControlPoint | null) => {
    if (current.current?.control.kind !== 'agent') return
    setNudge((n) => n + 1)
    if (!at) return
    const id = ++sequence.current
    setBubble({ id, at, leaving: false })
    setClicks((list) => [...list.slice(1 - KEPT_CLICKS), { id, at }])
    clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => {
      setBubble((b) => (b?.id === id ? { ...b, leaving: true } : b))
      bubbleTimer.current = setTimeout(
        () => setBubble((b) => (b?.id === id ? null : b)),
        BUBBLE_LEAVE_MS,
      )
    }, HELD_BUBBLE_MS)
  }, [])

  useEffect(() => {
    const off = overlay.onEvent((event) => {
      if (event.type === 'state') {
        current.current = event.state
        setState(event.state)
        if (event.state.control.kind !== 'agent') {
          setBubble(null)
          setPointer(null)
        }
        return
      }
      if (event.type === 'act') {
        const { at, click } = event
        setAct((last) => ({ count: last.count + 1, at }))
        if (at) setPointer((last) => ({ at, clicks: (last?.clicks ?? 0) + (click ? 1 : 0) }))
        return
      }
      held(event.at)
    })
    overlay.request({ type: 'ready' })
    return off
  }, [held])

  // Keys typed while the overlay has the keyboard are held back too; Tab and the pill's buttons work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.key === 'Tab') return
      const button = event.target instanceof HTMLButtonElement
      if (button && (event.key === 'Enter' || event.key === ' ')) return
      held(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held])

  useEffect(() => () => clearTimeout(bubbleTimer.current), [])

  // Main sizes the overlay to the pill while the user has the surface.
  const measurePill = useCallback((element: HTMLDivElement | null) => {
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.offsetWidth === 0 || element.offsetHeight === 0) return
      overlay.request({
        type: 'pill',
        width: element.offsetWidth + 2 * OVERLAY_PILL_ROOM,
        height: element.offsetHeight + 2 * OVERLAY_PILL_ROOM,
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** The wheel goes through to the surface, once a frame. */
  const onWheel = (event: WheelEvent) => {
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
    const clamp = (value: number) => Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, value))
    const pending = wheel.current
    if (pending) {
      pending.x = event.clientX
      pending.y = event.clientY
      pending.deltaX = clamp(pending.deltaX + event.deltaX * unit)
      pending.deltaY = clamp(pending.deltaY + event.deltaY * unit)
      return
    }
    wheel.current = {
      x: event.clientX,
      y: event.clientY,
      deltaX: clamp(event.deltaX * unit),
      deltaY: clamp(event.deltaY * unit),
    }
    requestAnimationFrame(() => {
      const step = wheel.current
      wheel.current = null
      if (step) overlay.request({ type: 'wheel', ...step })
    })
  }

  if (!state) return null
  const { control, layout } = state
  const full = layout === 'full'
  const agentState = control.kind === 'agent' && full
  const active = control.kind === 'idle' ? null : control
  const agentName = state.agent?.name ?? t('agent')
  const scope = t(`scope.${state.scope}`)
  const takeOver = () => overlay.request({ type: 'take-over' })

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ '--surface-width': `${state.width}px` } as CSSProperties}
      onPointerDown={(event) => {
        if (!agentState || event.button !== 0) return
        if ((event.target as Element).closest('.ctl-pill-nudge, .ctl-bubble')) return
        held({ x: event.clientX, y: event.clientY })
      }}
      onWheel={full ? onWheel : undefined}
      onContextMenu={(event) => event.preventDefault()}
    >
      <AnimatePresence>
        {agentState && (
          <SurfaceLight key="light" act={act.count} at={act.at} radius={state.radius} />
        )}
      </AnimatePresence>
      {agentState && pointer && (
        <ControlPointer id="agent" name={agentName} at={pointer.at} click={pointer.clicks} />
      )}
      {agentState &&
        clicks.map((click) => (
          <span
            key={click.id}
            aria-hidden
            className="ctl-click"
            style={{ left: click.at.x, top: click.at.y }}
            onAnimationEnd={() => setClicks((list) => list.filter((c) => c.id !== click.id))}
          />
        ))}
      {agentState && bubble && (
        <HeldBubble
          key={bubble.id}
          at={bubble.at}
          agentName={agentName}
          scope={scope}
          leaving={bubble.leaving}
          onTakeOver={takeOver}
        />
      )}
      <div
        ref={measurePill}
        className="ctl-overlay-pill"
        style={{ bottom: full ? OVERLAY_PILL_BOTTOM : OVERLAY_PILL_ROOM }}
      >
        <AnimatePresence>
          {active && (
            <SurfacePill
              key="pill"
              control={active}
              agent={state.agent}
              agentName={agentName}
              scope={scope}
              nudge={nudge}
              onTakeOver={takeOver}
              onHandBack={() => overlay.request({ type: 'hand-back' })}
              onDone={() => overlay.request({ type: 'answer', outcome: 'done' })}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
