import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import { CornerDownRightIcon, PencilIcon, PlayIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Attachment, QueuedPrompt, SessionView } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { follow, springs } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { restoreAttachments } from './composer/attachments'
import {
  actionCard,
  BEHIND,
  clampOffset,
  foldedPose,
  openPose,
  reserveHeight,
  shownRange,
  snapOffset,
  stackHeight,
  type CardPose,
} from './queue-layout'

// Hover intent: the stack fans out once the pointer rests on it, so crossing it on the way to the
// composer does nothing, and folds a moment after the pointer leaves, so a slip does not.
const OPEN_DELAY = 150
const CLOSE_DELAY = 180
// A wheel notch (100 px in Chromium) moves one card; it settles on a whole card once it stops.
const WHEEL_PER_CARD = 100
const SNAP_DELAY = 120

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

/** A card's fill: the composer's surface at the front, darkening toward `--queue-back` behind. */
function fill(depth: number): CSSProperties['backgroundColor'] {
  return `color-mix(in oklab, var(--bg-surface), var(--queue-back) ${Math.round(depth * 100)}%)`
}

// A menu, dialog or list open over the session takes Esc first.
const overlayOpen = () =>
  !!document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]')

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
  /** The latest action's error, or null once another starts or the queue empties. */
  onError: (message: string | null) => void
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
  // Focus is inside the stack; a node removed while focused reports no blur, so this tracks it.
  const focused = useRef(false)
  const refocusing = useRef(false)

  const shownOffset = open ? clampOffset(offset, count) : 0
  const front = snapOffset(shownOffset, count)
  // The wheel listener reads these between renders.
  const latest = useRef({ open, count, offset: shownOffset })
  useLayoutEffect(() => {
    latest.current = { open, count, offset: shownOffset }
  })

  const fold = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    openTimer.current = undefined
    setOpen(false)
    setOffset(0)
    setFollowing(false)
    setHovered(null)
  }, [])
  const fan = () => {
    clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const step = (by: number) => {
    setOffset(snapOffset(front + by, count))
    setFollowing(false)
  }

  useEffect(() => onOpenChange(open), [open, onOpenChange])

  // Leaving with focus inside, as when the last message goes, hands it to the composer.
  useLayoutEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
      if (region.current?.contains(document.activeElement)) {
        emitAppEvent({ kind: 'focus-composer' })
      }
      onOpenChange(false)
      onError(null)
    },
    [onOpenChange, onError],
  )

  // A focused action that goes inert or leaves with its card would drop focus to the page, where
  // Esc cancels the turn; it moves to the stack instead.
  useLayoutEffect(() => {
    const el = region.current
    const active = document.activeElement
    if (!focused.current || !el || active === el) return
    if (el.contains(active) && !active?.closest('[inert]')) return
    refocusing.current = true
    el.focus({ preventScroll: true })
    refocusing.current = false
  })

  // Esc folds the stack wherever focus is, before the composer's Esc cancels the turn.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (overlayOpen()) return
      event.preventDefault()
      event.stopPropagation()
      fold()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, fold])

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
    onError(null)
    request.catch((e: unknown) => onError(errorMessage(e)))
  }
  const actions: CardActions = {
    resume: () => run(host('sessions.resumeQueue', { sessionId })),
    steer: (item) => run(host('sessions.steer', { sessionId, itemId: item.id })),
    edit: (item) =>
      run(
        host('sessions.unqueue', { sessionId, itemId: item.id }).then(() => {
          if (restoreAttachments(sessionId, item.content) > 0) {
            onError(t('attachments.limit', { ns: 'composer' }))
          }
          const text = promptText(item)
          emitAppEvent(
            text ? { kind: 'insert-into-composer', sessionId, text } : { kind: 'focus-composer' },
          )
        }),
      ),
    remove: (item) =>
      run(
        host('sessions.unqueue', { sessionId, itemId: item.id }).then(() =>
          Promise.all(
            queuedAttachments(item).map((attachment) =>
              host('attachments.remove', { id: attachment.id }),
            ),
          ),
        ),
      ),
  }

  const live = actionCard({
    open,
    following,
    front,
    hovered: hovered === null ? -1 : queue.findIndex((item) => item.id === hovered),
    keyboard,
  })
  const [start, end] = shownRange(count, open, shownOffset)

  return (
    // Isolated, so the cards' z-indexes stay below the composer that covers their lower edge.
    <div
      className="relative isolate mt-1 animate-in fade-in animation-duration-(--duration-base)"
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
          focused.current = true
          // Focus kept inside after an action left keeps the stack as it is.
          if (!refocusing.current) fan()
        }}
        onBlur={(event) => {
          if (region.current?.contains(event.relatedTarget as Node | null)) return
          focused.current = false
          setKeyboard(false)
          setRinged(false)
          fold()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
          event.preventDefault()
          if (!open) fan()
          else step(event.key === 'ArrowUp' ? 1 : -1)
        }}
        style={{ height: stackHeight(count, open) }}
        className="absolute inset-x-1 -bottom-2 outline-none"
      >
        <ul className="relative size-full">
          <AnimatePresence initial={false}>
            {queue.slice(start, end).map((item, i) => {
              const index = start + i
              return (
                <QueueCard
                  key={item.id}
                  item={item}
                  index={index}
                  pose={open ? openPose(index, shownOffset) : foldedPose(index)}
                  following={following}
                  live={index === live}
                  ringed={ringed && index === front}
                  count={
                    index !== front
                      ? null
                      : open
                        ? t('queue.position', { number: index + 1, count })
                        : queuePaused
                          ? t('queue.pausedCount', { count })
                          : t('queue.queued', { count })
                  }
                  canResume={index === 0 && queuePaused}
                  canSteer={steering && running}
                  actions={actions}
                  onHover={() => setHovered(item.id)}
                />
              )
            })}
          </AnimatePresence>
        </ul>
      </div>
    </div>
  )
}

interface CardActions {
  resume: () => void
  steer: (item: QueuedPrompt) => void
  edit: (item: QueuedPrompt) => void
  remove: (item: QueuedPrompt) => void
}

/** One queued message; while it leaves, its actions are inert so they cannot fire twice. */
function QueueCard({
  item,
  index,
  pose,
  following,
  live,
  ringed,
  count,
  canResume,
  canSteer,
  actions,
  onHover,
}: {
  item: QueuedPrompt
  index: number
  pose: CardPose
  following: boolean
  live: boolean
  ringed: boolean
  count: string | null
  canResume: boolean
  canSteer: boolean
  actions: CardActions
  onHover: () => void
}) {
  const { t } = useTranslation('session')
  const present = useIsPresent()
  const shown = live && present
  const attachments = queuedAttachments(item).length
  return (
    <motion.li
      initial={{ opacity: 0, y: pose.y, scale: pose.scale }}
      animate={{ opacity: pose.opacity, y: pose.y, scale: pose.scale }}
      exit={{ opacity: 0, y: BEHIND, scale: 0.97 }}
      transition={following ? follow : springs.card}
      onPointerEnter={onHover}
      aria-hidden={pose.content === 0 || !present || undefined}
      style={{
        zIndex: pose.z,
        originY: 1,
        backgroundColor: shown ? 'var(--bg-surface)' : fill(pose.depth),
      }}
      className={cn(
        'absolute inset-x-2 bottom-0 h-11 rounded-xl shadow-queue transition-[background-color] duration-(--duration-base)',
        (!pose.interactive || !present) && 'pointer-events-none',
        ringed && 'outline-2 outline-offset-2 outline-focus',
      )}
    >
      <div
        style={{ opacity: pose.content }}
        className="flex h-9 items-center gap-2 px-3 transition-opacity duration-(--duration-base)"
      >
        <span className="w-10 shrink-0 text-xs text-muted-foreground">
          {index === 0 ? t('queue.next') : t('queue.number', { number: index + 1 })}
        </span>
        <span className="min-w-0 flex-1 truncate text-small">
          {promptText(item) || (attachments === 0 && t('queue.attachment'))}
          {attachments > 0 && (
            <span className="text-tertiary">
              {promptText(item) && ' · '}
              {t('queue.attachments', { count: attachments })}
            </span>
          )}
        </span>
        {count && <span className="shrink-0 text-xs text-muted-foreground tabular">{count}</span>}
      </div>
      <span
        inert={!shown}
        className={cn(
          'absolute top-1.5 right-1.5 flex items-center opacity-0 transition-opacity duration-(--duration-fast)',
          shown && 'opacity-100',
        )}
      >
        <span aria-hidden className="h-6 w-8 bg-linear-to-r from-transparent to-popover" />
        <span className="flex items-center gap-0.5 rounded-lg bg-popover">
          {canResume && (
            <Button variant="outline" size="xs" onClick={actions.resume}>
              <PlayIcon data-icon="inline-start" />
              {t('queue.resume')}
            </Button>
          )}
          {canSteer && (
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="outline" size="xs" onClick={() => actions.steer(item)} />}
              >
                <CornerDownRightIcon data-icon="inline-start" />
                {t('queue.sendNow')}
              </TooltipTrigger>
              <TooltipContent>{t('queue.steer')}</TooltipContent>
            </Tooltip>
          )}
          <CardButton label={t('queue.edit')} onClick={() => actions.edit(item)}>
            <PencilIcon />
          </CardButton>
          <CardButton label={t('queue.remove')} onClick={() => actions.remove(item)}>
            <XIcon />
          </CardButton>
        </span>
      </span>
    </motion.li>
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
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
            className="[&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
