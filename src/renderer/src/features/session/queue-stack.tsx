import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownRightIcon, PencilIcon, PlayIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { QueuedPrompt, SessionView } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { host } from '@renderer/lib/host'
import { springs } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import {
  BEHIND,
  clampOffset,
  foldedPose,
  openPose,
  reserveHeight,
  shownRange,
  snapOffset,
  stackHeight,
} from './queue-layout'

// Hover intent: the stack fans out once the pointer rests on it, so crossing it on the way to the
// composer does nothing, and folds a moment after the pointer leaves, so a slip does not.
const OPEN_DELAY = 150
const CLOSE_DELAY = 180
// A wheel notch (100 px in Chromium) moves one card; it settles on a whole card once it stops.
const WHEEL_PER_CARD = 100
const SNAP_DELAY = 120
// While the wheel turns, the cards follow it at --duration-fast and --ease-out-quart.
const FOLLOW = { type: 'tween', duration: 0.12, ease: [0.165, 0.84, 0.44, 1] } as const

function promptText(item: QueuedPrompt): string {
  return item.content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .join(' ')
    .trim()
}

/** A card's fill: the composer's surface at the front, fading toward `--queue-back` behind. */
function fill(depth: number): CSSProperties['backgroundColor'] {
  return `color-mix(in oklab, var(--popover), var(--queue-back) ${Math.round(depth * 100)}%)`
}

/**
 * The prompts waiting for the running turn, as a stack of cards tucked behind the composer. The
 * next one shows with the count; resting the pointer on it, or focusing it, fans three out, and
 * the wheel or the arrow keys move through the rest. The card under the pointer, or the front one
 * from the keyboard, offers its actions: Send now where the agent can steer, Edit in the composer,
 * Remove, and Resume on a paused queue's next message.
 */
export function QueueStack({
  session,
  onOpenChange,
  onError,
}: {
  session: SessionView
  onOpenChange: (open: boolean) => void
  onError: (error: unknown) => void
}) {
  const { t } = useTranslation('session')
  const steering = useAgentsStore((s) => !!s.byId[session.agentId]?.capabilities.steering)
  const { queue, queuePaused, status } = session
  const running = status === 'running' || status === 'awaiting_permission'
  const sessionId = session.id
  const count = queue.length

  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [following, setFollowing] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [keyboard, setKeyboard] = useState(false)
  // The stack itself has keyboard focus, which its front card shows.
  const [ringed, setRinged] = useState(false)
  const region = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)

  const shownOffset = open ? clampOffset(offset, count) : 0
  const front = snapOffset(shownOffset, count)
  // The wheel listener reads these between renders.
  const latest = useRef({ open, count, offset: shownOffset })
  useLayoutEffect(() => {
    latest.current = { open, count, offset: shownOffset }
  })

  useEffect(() => onOpenChange(open), [open, onOpenChange])
  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    [],
  )

  const fold = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    openTimer.current = undefined
    setOpen(false)
    setOffset(0)
    setFollowing(false)
    setHovered(null)
  }
  const fan = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const step = (by: number) => {
    setOffset(snapOffset(front + by, count))
    setFollowing(false)
  }

  // A wheel listener of its own, since React's is passive and the thread must not scroll too.
  useEffect(() => {
    const el = region.current
    if (!el) return
    let pending = 0
    let frame = 0
    let snap: number | undefined
    const onWheel = (event: WheelEvent) => {
      if (!latest.current.open || latest.current.count <= 1) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      pending += event.deltaY * unit
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          // Turning the wheel up moves further into the queue, which lies above.
          const next = clampOffset(
            latest.current.offset - pending / WHEEL_PER_CARD,
            latest.current.count,
          )
          pending = 0
          latest.current.offset = next
          setOffset(next)
          setFollowing(true)
        })
      }
      clearTimeout(snap)
      snap = window.setTimeout(() => {
        setOffset(snapOffset(latest.current.offset, latest.current.count))
        setFollowing(false)
      }, SNAP_DELAY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(frame)
      clearTimeout(snap)
    }
  }, [])

  const run = (request: Promise<unknown>) => {
    request.catch(onError)
  }
  const edit = (item: QueuedPrompt) =>
    run(
      host('sessions.unqueue', { sessionId, itemId: item.id }).then(() =>
        emitAppEvent({ kind: 'insert-into-composer', sessionId, text: promptText(item) }),
      ),
    )

  const hoveredIndex = hovered === null ? -1 : queue.findIndex((item) => item.id === hovered)
  const liveIndex = !open
    ? -1
    : hoveredIndex >= front && hoveredIndex <= front + 2
      ? hoveredIndex
      : keyboard
        ? front
        : -1
  const [start, end] = shownRange(count, open, shownOffset)

  return (
    <div
      className="relative mt-1 animate-in fade-in animation-duration-(--duration-base)"
      style={{ height: reserveHeight(count) }}
    >
      <div
        ref={region}
        role="group"
        tabIndex={0}
        aria-label={t('queue.label', { count })}
        onPointerEnter={() => {
          clearTimeout(closeTimer.current)
          if (!open && openTimer.current === undefined) {
            openTimer.current = window.setTimeout(() => {
              openTimer.current = undefined
              setOpen(true)
            }, OPEN_DELAY)
          }
        }}
        onPointerLeave={() => {
          clearTimeout(openTimer.current)
          openTimer.current = undefined
          setHovered(null)
          if (!keyboard) closeTimer.current = window.setTimeout(fold, CLOSE_DELAY)
        }}
        onFocus={(event) => {
          const self = event.target === event.currentTarget
          const visible = self && event.target.matches(':focus-visible')
          if (visible) setKeyboard(true)
          setRinged(visible)
          fan()
        }}
        onBlur={(event) => {
          if (region.current?.contains(event.relatedTarget as Node | null)) return
          setKeyboard(false)
          setRinged(false)
          fold()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) fan()
            else step(event.key === 'ArrowUp' ? 1 : -1)
          } else if (event.key === 'Escape' && open) {
            // Before the session's own Esc, which would cancel the turn.
            event.preventDefault()
            fold()
          }
        }}
        style={{ height: stackHeight(count, open) }}
        className="absolute inset-x-1 -bottom-2 outline-none"
      >
        <ul className="relative size-full">
          <AnimatePresence initial={false}>
            {queue.slice(start, end).map((item, i) => {
              const index = start + i
              const pose = open ? openPose(index, shownOffset) : foldedPose(index)
              const live = index === liveIndex && !following
              return (
                <motion.li
                  key={item.id}
                  initial={{ opacity: 0, y: pose.y, scale: pose.scale }}
                  animate={{ opacity: pose.opacity, y: pose.y, scale: pose.scale }}
                  exit={{ opacity: 0, y: BEHIND, scale: 0.97 }}
                  transition={following ? FOLLOW : springs.card}
                  onPointerEnter={() => setHovered(item.id)}
                  aria-hidden={pose.content === 0 || undefined}
                  style={{
                    zIndex: pose.z,
                    originY: 1,
                    backgroundColor: live ? 'var(--popover)' : fill(pose.depth),
                  }}
                  className={cn(
                    'absolute inset-x-2 bottom-0 h-11 rounded-xl shadow-composer transition-[background-color] duration-(--duration-base)',
                    !pose.interactive && 'pointer-events-none',
                    ringed && index === front && 'outline-2 outline-ring/50',
                  )}
                >
                  <div
                    style={{ opacity: pose.content }}
                    className="flex h-9 items-center gap-2 pr-3 pl-3 transition-opacity duration-(--duration-base)"
                  >
                    <span className="w-8 shrink-0 text-xs text-muted-foreground">
                      {index === 0 ? t('queue.next') : t('queue.number', { number: index + 1 })}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-small">
                      {promptText(item) || t('queue.attachment')}
                    </span>
                    {index === front && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular">
                        {open
                          ? t('queue.position', { number: index + 1, count })
                          : queuePaused
                            ? t('queue.pausedCount', { count })
                            : t('queue.queued', { count })}
                      </span>
                    )}
                  </div>
                  <span
                    inert={!live}
                    className={cn(
                      'absolute top-1.5 right-1.5 flex items-center opacity-0 transition-opacity duration-(--duration-fast)',
                      live && 'opacity-100',
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-6 w-8 bg-linear-to-r from-transparent to-popover"
                    />
                    <span className="flex items-center gap-0.5 rounded-lg bg-popover">
                      {index === 0 && queuePaused && (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => run(host('sessions.resumeQueue', { sessionId }))}
                        >
                          <PlayIcon data-icon="inline-start" />
                          {t('queue.resume')}
                        </Button>
                      )}
                      {steering && running && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  run(host('sessions.steer', { sessionId, itemId: item.id }))
                                }
                              />
                            }
                          >
                            <CornerDownRightIcon data-icon="inline-start" />
                            {t('queue.sendNow')}
                          </TooltipTrigger>
                          <TooltipContent>{t('queue.steer')}</TooltipContent>
                        </Tooltip>
                      )}
                      <CardButton label={t('queue.edit')} onClick={() => edit(item)}>
                        <PencilIcon />
                      </CardButton>
                      <CardButton
                        label={t('queue.remove')}
                        onClick={() =>
                          run(host('sessions.unqueue', { sessionId, itemId: item.id }))
                        }
                      >
                        <XIcon />
                      </CardButton>
                    </span>
                  </span>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      </div>
    </div>
  )
}

function CardButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="quiet" size="icon-xs" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
