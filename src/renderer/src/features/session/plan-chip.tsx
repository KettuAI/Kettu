import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { PlanItem, SessionStatus } from '@shared/thread'
import { AgentSteering, type SteerStep } from '@renderer/components/affect/agent-steering'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { useThreadsStore } from '@renderer/stores/threads'
import { stepTime } from './plan-times'

const EASE_OUT_QUART = [0.165, 0.84, 0.44, 1] as const

/** The plan's own turn running, that turn waiting for the user, or no longer its turn. */
type Tone = 'running' | 'waiting' | 'ended'

const STEP_STATUS = {
  completed: 'done',
  in_progress: 'active',
  pending: 'pending',
} as const satisfies Record<PlanItem['status'], SteerStep['status']>

/**
 * The session's plan in its top bar: a ring with a segment per step, the current step and which
 * step it is; pointing at it shows the steps on affectUI's Agent Steering, one line each. The bar
 * already names the run and steering happens in the composer, so the card has neither. It leaves
 * once every step is done and its turn ended.
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
          className="app-region-no-drag flex min-w-0 shrink-1000 items-center"
        >
          <Chip sessionId={sessionId} items={items} tone={tone} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Chip({ sessionId, items, tone }: { sessionId: string; items: PlanItem[]; tone: Tone }) {
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
  const steps: SteerStep[] = items.map((item, i) => {
    const time = stepTime(sessionId, item, i)
    return {
      id: String(i),
      title: item.content,
      status: STEP_STATUS[item.status],
      ...(time.durationMs !== undefined ? { duration: time.durationMs } : {}),
      ...(time.startedAt !== undefined ? { startedAt: time.startedAt } : {}),
    }
  })
  // The running step's clock ticks only from a start this window saw.
  const clocked = doing >= 0 && stepTime(sessionId, items[doing]!, doing).startedAt !== undefined

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={200}
        closeDelay={200}
        aria-label={label}
        render={<button type="button" />}
        className="ks-chip ks-plan-chip"
        data-tone={tone}
      >
        <PlanRing items={items} />
        {text && (
          // The step's text gives way first: it shrinks, then hides in a narrow bar.
          <span className="ks-chip__text @max-[48rem]/top-bar:hidden">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={text}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: EASE_OUT_QUART }}
                className="block truncate"
              >
                {text}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
        <span aria-hidden className="ks-chip__dim tabular @max-[40rem]/top-bar:hidden">
          {t('planChip.count', { step, total })}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        alignOffset={0}
        sideOffset={8}
        className="ks-plan-pop w-[380px] max-w-[calc(100vw-32px)] overflow-hidden p-0"
      >
        <AgentSteering
          title={label}
          steps={steps}
          queue={[]}
          status={
            tone === 'running' && clocked
              ? 'running'
              : steps.every((s) => s.status === 'done')
                ? 'done'
                : 'paused'
          }
          head={false}
          compose={false}
          planLabel={t('planChip.title')}
        />
      </HoverCardContent>
    </HoverCard>
  )
}

/** A segment per step, clockwise from the top; past twelve steps they join into one ring. */
function PlanRing({ items }: { items: PlanItem[] }) {
  const count = items.length
  const gap = count > 12 ? 0 : 0.18
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" className="ks-plan-ring">
      {items.map((item, i) => {
        if (count === 1) {
          return <circle key={i} cx="8" cy="8" r="6" data-status={item.status} />
        }
        const a0 = (i / count) * 2 * Math.PI - Math.PI / 2 + gap
        const a1 = ((i + 1) / count) * 2 * Math.PI - Math.PI / 2 - gap
        const p = (a: number) =>
          `${(8 + 6 * Math.cos(a)).toFixed(2)} ${(8 + 6 * Math.sin(a)).toFixed(2)}`
        return (
          <path
            key={i}
            d={`M${p(a0)} A6 6 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`}
            data-status={item.status}
          />
        )
      })}
    </svg>
  )
}
