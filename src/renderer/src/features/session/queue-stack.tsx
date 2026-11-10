import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { ArrowUp01Icon, Cancel01Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Attachment, QueuedPrompt, SessionView } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession } from '@renderer/stores/sessions'
import { restoreAttachments } from './composer/attachments'
import { Glyph } from '@renderer/features/shell/glyph'

function promptText(item: QueuedPrompt): string {
  return item.content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .join(' ')
    .trim()
}

function queuedAttachments(item: QueuedPrompt): Attachment[] {
  return item.content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment] : [],
  )
}

const STEP = 28 // how much of an open row shows above the one in front of it
const PEEK = 6 // how much of a folded card shows above the one in front of it
const INSET = 12 // each layer back is this much narrower on each side
const TUCK = 26 // how far the tab runs under the composer, .kettu-queue's negative bottom margin
const SHOWN = 3 // rows in view while open
const FADE = [1, 0.74, 0.54] // text of the rows in view, front to back
const TRAVEL = 44 // trackpad travel, in px, that moves the list one row
const EASE = 70 // ms; the list closes about 63% of the way to where it is headed in this time

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * The prompts waiting for the running turn, tucked behind the composer: the next one in front, the
 * next two peeking above. Pointing at it, or focusing it, fans them out as layers, each further
 * back narrower, fainter and tucked under the one in front, each offering Send now while a turn
 * runs, Edit in the composer and Remove. Past three, scrolling moves the list like a periscope,
 * following the wheel and settling on a whole row. A paused queue says so and offers to go on.
 */
export function QueueStack({
  session,
  onError,
}: {
  session: SessionView
  /** The latest action's error, or null once another starts or the queue empties. */
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation('session')
  const hostId = hostOfSession(session)
  const steering = useAgentsStore(
    (s) => !!agentsOn(s, hostId).byId[session.agentId]?.capabilities.steering,
  )
  const { queue, queuePaused, status } = session
  const running = status === 'running' || status === 'awaiting_permission'
  const sessionId = session.id
  const n = queue.length
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Rows scrolled past, fractional while the list moves
  const [offset, setOffset] = useState(0)
  const [scrolling, setScrolling] = useState(false)
  const leave = useRef(0)
  const anim = useRef({ target: 0, current: 0, raf: 0, last: 0, settle: 0 })
  const max = Math.max(0, n - SHOWN)

  // Leaving with focus inside, as when the last message goes, hands it to the composer.
  useLayoutEffect(
    () => () => {
      if (root.current?.contains(document.activeElement)) {
        emitAppEvent({ kind: 'focus-composer' })
      }
      onError(null)
    },
    [onError],
  )

  const stop = () => {
    const a = anim.current
    cancelAnimationFrame(a.raf)
    clearTimeout(a.settle)
    a.raf = 0
  }
  const run = () => {
    const a = anim.current
    if (a.raf) return
    setScrolling(true)
    a.last = performance.now()
    const tick = (now: number) => {
      const k = 1 - Math.exp(-(now - a.last) / EASE)
      a.last = now
      a.current += (a.target - a.current) * k
      if (Math.abs(a.target - a.current) < 0.002) {
        a.current = a.target
        a.raf = 0
        setOffset(a.current)
        setScrolling(false)
        return
      }
      setOffset(a.current)
      a.raf = requestAnimationFrame(tick)
    }
    a.raf = requestAnimationFrame(tick)
  }
  useEffect(() => stop, [])
  useEffect(() => {
    const el = root.current
    if (!el || !open) return
    const onWheel = (e: WheelEvent) => {
      if (!max) return
      e.preventDefault()
      const a = anim.current
      if (Math.abs(e.deltaY) >= 50) {
        // A mouse wheel notch moves one whole row
        a.target = clamp(Math.round(a.target) + (e.deltaY < 0 ? 1 : -1), 0, max)
      } else {
        // A trackpad drags the list along; past either end it gives a little and springs back
        const delta = -e.deltaY / TRAVEL
        const next = a.target + delta
        a.target = next < 0 || next > max ? clamp(a.target + delta * 0.3, -0.3, max + 0.3) : next
      }
      clearTimeout(a.settle)
      a.settle = window.setTimeout(() => {
        a.target = clamp(Math.round(a.target), 0, max)
        run()
      }, 140)
      run()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open, max])
  // A queue that shrank leaves no rows scrolled past its end.
  useEffect(() => {
    const a = anim.current
    if (a.raf || a.target <= max) return
    a.target = a.current = max
    setOffset(max)
  }, [max])

  if (n === 0) return null

  const show = () => {
    clearTimeout(leave.current)
    setOpen(true)
  }
  const close = () => {
    stop()
    anim.current.target = anim.current.current = 0
    setScrolling(false)
    setOpen(false)
    setOffset(0)
  }
  const hide = () => {
    leave.current = window.setTimeout(close, 160)
  }

  const act = (request: Promise<unknown>) => {
    onError(null)
    request.catch((e: unknown) => onError(errorMessage(e)))
  }
  const sendNow = (item: QueuedPrompt) =>
    act(host('sessions.sendNow', { sessionId, itemId: item.id }))
  const edit = (item: QueuedPrompt) =>
    act(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() => {
        if (restoreAttachments(sessionId, item.content) > 0) {
          onError(t('attachments.limit', { ns: 'composer' }))
        }
        const text = promptText(item)
        emitAppEvent(
          text ? { kind: 'insert-into-composer', sessionId, text } : { kind: 'focus-composer' },
        )
      }),
    )
  const remove = (item: QueuedPrompt) =>
    act(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() =>
        Promise.all(
          queuedAttachments(item).map((attachment) =>
            host('attachments.remove', { id: attachment.id }),
          ),
        ),
      ),
    )
  const resume = () => act(host('sessions.resumeQueue', { sessionId }))

  // Every value is continuous in the card's position, so the list never jumps while it moves.
  // depth is 0 for the card in front and grows toward the back; it sets the width and the tint.
  // shape goes from the tab tucked behind the composer (0) to a row (1).
  const place = (i: number) => {
    if (!open) {
      const k = Math.min(i, 2)
      return {
        y: -k * PEEK,
        depth: k,
        shape: 0,
        content: i === 0 ? 1 : 0,
        front: i === 0 ? 1 : 0,
        alpha: i > 2 ? 0 : 1,
        z: 50 - i,
      }
    }
    const pos = i - offset
    const z = 100 - Math.round(pos * 10)
    const front = clamp(1 - Math.abs(pos), 0, 1)
    if (pos < 0) {
      // Scrolled past: slides down under the composer
      const d = -pos
      return {
        y: d * 30,
        depth: 0,
        shape: 0,
        content: clamp(1 - d * 1.4, 0, 1),
        front,
        alpha: clamp(1 - d, 0, 1),
        z,
      }
    }
    const last = SHOWN - 1
    if (pos <= last) {
      const lo = Math.floor(pos)
      const content = lerp(FADE[lo]!, FADE[Math.min(lo + 1, last)]!, pos - lo)
      return { y: -pos * STEP, depth: pos, shape: Math.min(pos, 1), content, front, alpha: 1, z }
    }
    // Above the view: folds into a peek, three at most
    const d = pos - last
    return {
      y: -last * STEP - Math.min(d, 3) * PEEK,
      depth: last + Math.min(d, 3),
      shape: 1,
      content: FADE[last]! * clamp(1 - d, 0, 1),
      front: 0,
      alpha: clamp(3 - d, 0, 1),
      z,
    }
  }

  return (
    <div
      ref={root}
      role="region"
      className="kettu-queue"
      data-open={open || undefined}
      data-scrolling={scrolling || undefined}
      style={{ '--shown': Math.min(n, SHOWN) } as CSSProperties}
      aria-label={t('queue.label', { count: n })}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && hide()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        event.stopPropagation()
        close()
        emitAppEvent({ kind: 'focus-composer' })
      }}
    >
      {queue.map((item, i) => {
        const p = place(i)
        const text = promptText(item)
        const attachments = queuedAttachments(item).length
        return (
          <div
            key={item.id}
            className="kettu-queue__card"
            data-row={(open && p.shape > 0.5 && p.content > 0) || undefined}
            style={
              {
                transform: `translateY(${p.y}px)`,
                left: p.depth * INSET,
                right: p.depth * INSET,
                height: 48 - 12 * p.shape,
                // Centres the text on what shows: above the composer as a tab, above the next row
                paddingBottom: lerp(TUCK, 48 - 12 - STEP, p.shape),
                borderRadius: `${12 - 2 * p.shape}px ${12 - 2 * p.shape}px ${10 * p.shape}px ${10 * p.shape}px`,
                opacity: p.alpha,
                zIndex: p.z,
                '--c': p.content,
                '--front': p.front,
                // The count fades out before it folds, so no clipped digit shows while it narrows
                '--count': clamp(p.front * 2 - 1, 0, 1),
                '--mix': `${Math.max(2, 5 - p.depth)}%`,
              } as CSSProperties
            }
            tabIndex={p.content > 0.3 ? 0 : -1}
          >
            <span className="kettu-queue__n" aria-hidden>
              {i + 1}
            </span>
            <span className="kettu-queue__text">
              {text || (attachments === 0 && t('queue.attachment'))}
              {attachments > 0 && (
                <span className="kettu-queue__dim">
                  {text && ' · '}
                  {t('queue.attachments', { count: attachments })}
                </span>
              )}
            </span>
            {item.device && (
              <span className="kettu-queue__from">
                {t('queue.from', { device: item.device.name })}
              </span>
            )}
            {i === 0 && queuePaused && (
              <span className="kettu-queue__paused">
                {t('queue.paused')}
                <button type="button" className="kettu-queue__resume" onClick={resume}>
                  {t('queue.resume')}
                </button>
              </span>
            )}
            <span className="kettu-queue__count">
              {t('queue.count', { count: n })}
              <Glyph icon={ArrowUp01Icon} size={12} />
            </span>
            <span className="kettu-queue__actions">
              {running && (
                <QueueAction
                  label={t('queue.sendNow')}
                  tip={t(steering ? 'queue.steer' : 'queue.stopAndSend')}
                  onClick={() => sendNow(item)}
                >
                  <ReturnGlyph />
                </QueueAction>
              )}
              <QueueAction label={t('queue.edit')} onClick={() => edit(item)}>
                <Glyph icon={PencilEdit02Icon} size={14} />
              </QueueAction>
              <QueueAction label={t('queue.remove')} onClick={() => remove(item)}>
                <Glyph icon={Cancel01Icon} size={14} />
              </QueueAction>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function QueueAction({
  label,
  tip = label,
  onClick,
  children,
}: {
  label: string
  tip?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={label} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

/** The return key glyph, at the shell's stroke: the icon set only has curved turn arrows. */
function ReturnGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 5v6a4 4 0 0 1-4 4H4" />
      <path d="m9 10-5 5 5 5" />
    </svg>
  )
}
