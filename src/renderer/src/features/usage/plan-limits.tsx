import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { countdown } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { LIMIT_TEXT } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { isInstalled, useAgentsStore } from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { limitsToRead, resetForm } from './model'
import {
  planColumns,
  ringStroke,
  usageCards,
  type CardRing,
  type LimitRead,
  type UsageCard,
} from './plan-cards'

const RINGS = 72
/** The grid for each column count; two a row while the page is narrow. */
const COLUMNS = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 @min-[45rem]:grid-cols-3',
  4: 'grid-cols-2 @min-[45rem]:grid-cols-4',
} as const

/**
 * The plans as they stand, across the page: a card per account that reports limits, as many to
 * a row as leave the last row fullest, then one line for the agents with usage that report none.
 */
export function PlanLimits({ used }: { used: readonly AgentId[] }) {
  const { t } = useTranslation('usage')
  const now = useNow()
  const agents = useAgentsStore(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id])
        .filter((a): a is AgentStatus => !!a && a.registered !== false && !a.disabled),
    ),
  )
  // Read afresh when the page opens; the host asks each agent at most once a minute.
  const [toRead] = useState(() =>
    limitsToRead(
      Object.values(useAgentsStore.getState().byId).filter((a): a is AgentStatus => !!a),
    ),
  )
  const [reads, setReads] = useState<Partial<Record<AgentId, LimitRead>>>(() =>
    Object.fromEntries(toRead.map((agent) => [agent.id, 'reading' as const])),
  )
  useEffect(() => {
    for (const agent of toRead) {
      refreshLimits(agent.id).then(
        () =>
          setReads((was) => {
            const next = { ...was }
            delete next[agent.id]
            return next
          }),
        (error: unknown) => {
          console.warn(`Could not read the plan limits: ${errorMessage(error)}`)
          setReads((was) => ({ ...was, [agent.id]: 'failed' }))
        },
      )
    }
  }, [toRead])
  const { cards, unreported } = usageCards(agents, used, reads, now)
  const read = Math.max(0, ...cards.map((card) => card.readAt ?? 0))
  const names = new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
    unreported.map((a) => a.name),
  )
  const columns = planColumns(cards.length)
  return (
    <section aria-labelledby="plan-limits-title" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline gap-2 px-0.5">
        <h2 id="plan-limits-title" className="text-row font-semibold text-primary">
          {t('limits.title')}
        </h2>
        {cards.length > 0 && (
          <span className="text-hint text-tertiary">
            {t('limits.accounts', { count: cards.length })}
          </span>
        )}
        <span className="flex-1" />
        {read > 0 && (
          <span className="text-small text-tertiary">
            {t('limits.read', { ago: longAgo(read, now) })}
          </span>
        )}
      </div>
      {cards.length === 0 ? (
        <p className="rounded-card bg-card px-4.5 py-4 text-hint text-tertiary shadow-card">
          {t('limits.none')}
        </p>
      ) : (
        <div className={cn('grid gap-2.5', COLUMNS[columns])}>
          {cards.map((card) => (
            <PlanCard key={card.key} card={card} now={now} />
          ))}
        </div>
      )}
      {unreported.length > 0 && (
        <p className="px-0.5 text-hint text-tertiary">
          {t('limits.notReported', { name: names, count: unreported.length })}
        </p>
      )}
    </section>
  )
}

/** When a window resets, as its line and tooltip say it. */
function useResetText(): (ring: CardRing, now: number) => string | null {
  const { t } = useTranslation('usage')
  return (ring, now) => {
    const at = ring.limit.resetsAt
    if (at === null) return null
    return resetForm(at, now) === 'in' && at > now
      ? t('limits.resetsIn', { time: countdown(at - now)! })
      : t('limits.resetsAt', { time: resetWhen(at, now) })
  }
}

/**
 * An account's card: its mark, name and tier, then a ring per window beside a line per window,
 * the longest outside and first. Hovered or focused, it lists when each window resets.
 */
function PlanCard({ card, now }: { card: UsageCard; now: number }) {
  const { t } = useTranslation('usage')
  const installed = useAgentsStore((s) => {
    const agent = s.byId[card.agentId]
    return agent ? isInstalled(agent) : true
  })
  const resetText = useResetText()
  const failed = card.state === 'failed'
  const shortName = useShortWindow()
  const face = (
    <>
      <div className="flex h-5.5 min-w-0 items-center gap-2">
        <AgentMark agent={card.agentId} size={16} mono={!installed} />
        <span className="min-w-0 flex-1 truncate text-row font-semibold text-primary">
          {card.name}
        </span>
        {failed ? (
          <span className="shrink-0 rounded-md bg-danger-tint px-2 text-small leading-5.5 text-danger">
            {t('limits.failed')}
          </span>
        ) : (
          card.tier && (
            <span className="shrink-0 rounded-md bg-popover px-2 text-small leading-5.5 text-secondary shadow-[0_0_0_var(--hairline)_var(--border-subtle)]">
              {card.tier}
            </span>
          )
        )}
      </div>
      {card.state === 'reading' ? (
        <div aria-busy className="flex items-center gap-4">
          <span className="sr-only">{t('limits.reading')}</span>
          <Skeleton className="size-16 shrink-0 rounded-full" />
          <span className="flex flex-1 flex-col gap-2.25">
            <Skeleton className="h-2.5 w-4/5 rounded-sm" />
            <Skeleton className="h-2.5 w-3/5 rounded-sm" />
          </span>
        </div>
      ) : card.rings.length === 0 ? (
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="size-15.5 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--border-default)]"
          />
          <span className={cn('text-hint', failed ? 'text-danger' : 'text-tertiary')}>
            {failed ? t('limits.neverRead') : t('limits.notYet')}
          </span>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-4">
          <PlanRings
            rings={[...card.rings].reverse().map((ring) => ({
              id: ring.limit.window,
              percent: ring.percent,
              level: ring.level,
            }))}
            size={RINGS}
            {...ringStroke(card.rings.length, RINGS)}
            className={cn('size-18', failed && 'opacity-50')}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.75">
            {card.rings.map((ring) => {
              const name = limitLabel(ring.limit)
              const reset = resetText(ring, now)
              return (
                <span
                  key={ring.limit.window}
                  className={cn('flex items-baseline gap-2.5 text-control', failed && 'opacity-50')}
                >
                  <span aria-hidden className="min-w-0 flex-1 truncate text-tertiary">
                    {shortName(ring.limit)}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'shrink-0 font-semibold whitespace-nowrap tabular-nums',
                      ring.level === null
                        ? 'text-tertiary'
                        : ring.level === 'ok'
                          ? 'text-primary'
                          : LIMIT_TEXT[ring.level],
                    )}
                  >
                    {ring.percent === null
                      ? '—'
                      : ring.reached && ring.limit.resetsAt! > now
                        ? t('limits.backIn', { time: countdown(ring.limit.resetsAt! - now)! })
                        : `${ring.percent}%`}
                  </span>
                  {reset && (
                    <span
                      aria-hidden
                      className="hidden w-35 shrink-0 text-right text-small whitespace-nowrap text-tertiary @min-[25rem]:block"
                    >
                      {reset}
                    </span>
                  )}
                  <span className="sr-only">
                    {ring.percent === null
                      ? t('limits.windowStale', { window: name })
                      : t('limits.windowUsed', { window: name, percent: ring.percent })}
                    {reset && ` ${reset}`}
                  </span>
                </span>
              )
            })}
            {failed && card.readAt !== null && (
              <span className="mt-0.75 text-small text-danger">
                {t('limits.lastRead', { ago: longAgo(card.readAt, now) })}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )
  const tile =
    '@container flex min-w-0 flex-col gap-3 rounded-card bg-card px-4 pt-3.5 pb-4 shadow-card outline-none focus-ring'
  if (card.rings.length === 0) {
    return (
      <article aria-label={card.name} className={tile}>
        {face}
      </article>
    )
  }
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        closeDelay={100}
        render={
          <article
            tabIndex={0}
            aria-label={card.plan ? `${card.name}, ${card.plan}` : card.name}
            className={tile}
          />
        }
      >
        {face}
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={6} className="w-72">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1.5 text-hint">
          <span className="col-span-3 truncate font-semibold text-primary">
            {card.plan ? `${card.name} · ${card.plan}` : card.name}
          </span>
          {card.rings.map((ring) => (
            <span key={ring.limit.window} className="contents">
              <span className="truncate text-tertiary">{limitLabel(ring.limit)}</span>
              <span className="text-right font-semibold text-primary tabular-nums">
                {ring.percent === null ? '—' : `${ring.percent}%`}
              </span>
              <span className="text-right whitespace-nowrap text-secondary">
                {resetText(ring, now) ?? ''}
              </span>
            </span>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

/** A window's short name for its line: 5h, 7d, 7d · Fable, 30d. */
function useShortWindow(): (limit: CardRing['limit']) => string {
  const { t, i18n } = useTranslation(['usage', 'composer'])
  return (limit) => {
    const known = `composer:usage.shortWindow.${limit.window}`
    if (limit.window === 'rolling') return t('composer:usage.shortWindow.five_hour')
    if (limit.window === 'weekly') return t('composer:usage.shortWindow.seven_day')
    if (limit.window.startsWith('seven_day_')) {
      const model = /^Weekly · (.+)$/.exec(limit.label)?.[1] ?? limitLabel(limit)
      return t('usage:limits.weeklyOf', { model })
    }
    if (i18n.exists(known)) return t(known as 'composer:usage.shortWindow.five_hour')
    const counted = /^(\d+)_(minute|hour|day)$/.exec(limit.window)
    if (counted) {
      const unit = { minute: 'minutes', hour: 'hours', day: 'days' }[counted[2]!]!
      return t(`usage:limits.short.${unit}` as 'usage:limits.short.hours', {
        count: Number(counted[1]),
      })
    }
    return limitLabel(limit)
  }
}

/** When a window resets: its time today, its day and time within six days, its date beyond. */
function resetWhen(at: number, now: number): string {
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0)
  // Rounded, since a day across a change of the clocks is not 24 hours.
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  const format: Intl.DateTimeFormatOptions =
    days < 0 || days > 6
      ? { month: 'short', day: 'numeric' }
      : { ...(days > 0 && { weekday: 'short' }), hour: 'numeric', minute: '2-digit' }
  return new Intl.DateTimeFormat(currentLocale(), format).format(at)
}
