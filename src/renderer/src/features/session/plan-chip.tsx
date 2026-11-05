import { CheckIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { PlanItem, SessionStatus } from '@shared/thread'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'

const EASE_OUT_QUART = [0.165, 0.84, 0.44, 1] as const

/** The plan's own turn running, that turn waiting for the user, or no longer its turn. */
type Tone = 'running' | 'waiting' | 'ended'

/**
 * The session's plan in its top bar: a ring with a segment per step, the current step and which
 * step it is, showing the whole list on hover. It leaves once every step is done and its turn ended.
 */
export function PlanChip({ sessionId, status }: { sessionId: string; status: SessionStatus }) {
  const reduceMotion = useReducedMotion()
  const plan = useThreadsStore((s) => {
    const replica = s.replicas[sessionId]
    const state = replica?.state
    if (!state) return null
    for (let i = state.order.length - 1; i >= 0; i--) {
      const entry = state.byId[state.order[i]!]
      if (entry?.kind === 'plan') return entry
    }
    // The latest plan lies on a page not loaded yet.
    return replica.plan
  })
  // A prompt after the plan started a turn the plan is no part of.
  const ownTurn = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return false
    for (let i = state.order.length - 1; i >= 0; i--) {
      const entry = state.byId[state.order[i]!]
      if (entry?.kind === 'plan') return true
      if (entry?.kind === 'user' && !entry.steered) return false
    }
    return false
  })
  const items = plan && plan.items.length > 0 ? plan.items : null
  const running = ownTurn && (status === 'running' || status === 'awaiting_permission')
  const allDone = !!items && items.every((item) => item.status === 'completed')
  const tone: Tone = !running ? 'ended' : status === 'awaiting_permission' ? 'waiting' : 'running'

  return (
    <AnimatePresence initial={false}>
      {items && (!allDone || running) && (
        <motion.div
          key="plan"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE_OUT_QUART }}
          className="app-region-no-drag flex shrink-1000 items-center"
        >
          <Chip items={items} tone={tone} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Chip({ items, tone }: { items: PlanItem[]; tone: Tone }) {
  const { t } = useTranslation('session')
  const reduceMotion = useReducedMotion()
  const total = items.length
  const doing = items.findIndex((item) => item.status === 'in_progress')
  const next = items.findIndex((item) => item.status === 'pending')
  // Which step it is on: the one in progress, else the next one to do, else the last.
  const index = doing >= 0 ? doing : next >= 0 ? next : total - 1
  const step = index + 1
  const text = doing >= 0 || next >= 0 ? items[index]!.content : null
  const label = text
    ? t('planChip.label', { step, total, content: text })
    : t('planChip.labelDone', { total })

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={200}
        closeDelay={200}
        aria-label={label}
        render={<button type="button" />}
        className="flex h-6.5 min-w-0 items-center gap-1.75 rounded-full bg-subtle pr-2.5 pl-1.5 text-hint whitespace-nowrap text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-selected focus-ring data-popup-open:bg-selected"
      >
        <PlanRing items={items} tone={tone} />
        {text && (
          // The step's text gives way first: it shrinks, then hides in a narrow bar.
          <span className="relative flex max-w-60 min-w-0 @max-[48rem]/top-bar:hidden">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={text}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: EASE_OUT_QUART }}
                className={cn(
                  'min-w-0 truncate font-medium',
                  doing >= 0 && tone !== 'ended' ? 'text-foreground' : 'text-secondary',
                )}
              >
                {text}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
        <span aria-hidden className="shrink-0 tabular @max-[40rem]/top-bar:hidden">
          {t('planChip.count', { step, total })}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        alignOffset={0}
        // Clears the top bar's edge by 6px.
        sideOffset={17}
        className="w-80 p-1.5"
      >
        <div className="flex h-7 items-center justify-between px-2 text-small font-semibold text-tertiary">
          <span>{t('planChip.title')}</span>
          <span className="font-normal tabular">{t('planChip.step', { step, total })}</span>
        </div>
        <ol className="max-h-82 scroll-fade-y overflow-y-auto overscroll-contain">
          {items.map((item, i) => (
            <PlanStep key={i} item={item} tone={tone} />
          ))}
        </ol>
      </HoverCardContent>
    </HoverCard>
  )
}

function PlanStep({ item, tone }: { item: PlanItem; tone: Tone }) {
  const { t } = useTranslation('session')
  return (
    <li
      className={cn(
        'flex min-h-7.5 items-start gap-2.5 px-2 py-1.25 text-ui leading-5',
        item.status === 'completed'
          ? 'text-tertiary'
          : item.status === 'in_progress'
            ? cn('font-medium', tone === 'ended' ? 'text-secondary' : 'text-foreground')
            : 'text-secondary',
      )}
    >
      <span className="flex h-5 w-3.25 shrink-0 items-center justify-center">
        {item.status === 'completed' ? (
          <CheckIcon
            role="img"
            aria-label={t('status.done')}
            strokeWidth={1.8}
            className="size-3 text-tertiary"
          />
        ) : item.status === 'in_progress' ? (
          <span
            role="img"
            aria-label={t('plan.inProgress')}
            className={cn(
              'size-1.75 rounded-full',
              tone === 'ended'
                ? 'bg-(--text-tertiary)'
                : tone === 'waiting'
                  ? 'bg-(--focus) opacity-55'
                  : 'animate-pulse bg-(--focus)',
            )}
          />
        ) : (
          <span
            role="img"
            aria-label={t('plan.todo')}
            className="size-2 rounded-full border-[1.5px] border-strong"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">{item.content}</span>
    </li>
  )
}

/** A segment per step, clockwise from the top; past twelve steps they join into one ring. */
function PlanRing({ items, tone }: { items: PlanItem[]; tone: Tone }) {
  const count = items.length
  const gap = count > 12 ? 0 : count > 6 ? 12 : 22
  const span = 360 / count
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="none" strokeWidth={2.25} className="size-4 shrink-0">
      {items.map((item, i) =>
        count === 1 ? (
          <circle key={i} cx="8" cy="8" r={R} className={segment(item, tone)} />
        ) : (
          <path
            key={i}
            d={arc(i * span + gap / 2, (i + 1) * span - gap / 2)}
            className={segment(item, tone)}
          />
        ),
      )}
    </svg>
  )
}

const R = 6.625

/** An arc of the ring between two angles, in degrees clockwise from the top. */
function arc(from: number, to: number): string {
  const point = (deg: number): string => {
    const rad = ((deg - 90) * Math.PI) / 180
    return `${(8 + R * Math.cos(rad)).toFixed(2)} ${(8 + R * Math.sin(rad)).toFixed(2)}`
  }
  return `M${point(from)}A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${point(to)}`
}

function segment(item: PlanItem, tone: Tone): string {
  const base = 'transition-[stroke,opacity] duration-(--duration-slow)'
  if (item.status === 'pending') return cn(base, 'stroke-border')
  if (item.status === 'completed') {
    return cn(base, tone === 'ended' ? 'stroke-(--text-tertiary)' : 'stroke-(--focus)')
  }
  if (tone === 'ended') return cn(base, 'stroke-(--text-tertiary) opacity-40')
  if (tone === 'waiting') return cn(base, 'stroke-(--focus) opacity-55')
  return cn(base, 'animate-pulse stroke-(--focus)')
}
