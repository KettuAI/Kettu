import { useEffect, useState } from 'react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { countdown } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
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

/**
 * The plans as they stand, across the page: a card per account that reports limits, as many to
 * a row as leave the last row fullest, then one line for the agents with usage that report none.
 * Past two full rows the rest folds away, so the page's own figures stay in view.
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
  const [open, setOpen] = useState(false)
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
  const fold = columns * 2
  const shown = open || cards.length <= fold ? cards : cards.slice(0, fold)
  const hidden = cards.slice(fold)
  const near = hidden.filter((card) =>
    card.rings.some((ring) => ring.level === 'warn' || ring.level === 'bad'),
  ).length
  const head = [
    cards.length > 0 ? t('limits.accounts', { count: cards.length }) : null,
    read > 0 ? t('limits.read', { ago: longAgo(read, now) }) : null,
  ].filter(Boolean)
  return (
    <section className="k-u-sec" aria-labelledby="plan-limits-title">
      <header className="k-u-sec__head">
        <h2 id="plan-limits-title">{t('limits.title')}</h2>
        {head.length > 0 && <span>{head.join(' · ')}</span>}
      </header>
      {cards.length === 0 ? (
        <div className="k-u-card">
          <p className="k-u-none">{t('limits.none')}</p>
        </div>
      ) : (
        <div className="k-u-plans" data-cols={columns}>
          {shown.map((card) => (
            <PlanCard key={card.key} card={card} now={now} />
          ))}
        </div>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          className="k-u-plans__more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t('limits.showFewer') : t('limits.showMore', { count: hidden.length })}
          {!open && near > 0 && (
            <span className="k-u-plans__near">{t('limits.near', { count: near })}</span>
          )}
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      )}
      {unreported.length > 0 && (
        <p className="k-u-note">
          {t('limits.notReported', { name: names, count: unreported.length })}
        </p>
      )}
    </section>
  )
}

/** When a window resets, as its line and hover card say it. */
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
      <header>
        <AgentMark agent={card.agentId} size={16} mono={!installed} />
        <b>{card.name}</b>
        {failed ? (
          <span className="k-u-tier k-u-tier--bad">{t('limits.failed')}</span>
        ) : (
          card.tier && <span className="k-u-tier">{card.tier}</span>
        )}
      </header>
      {card.state === 'reading' ? (
        <div aria-busy className="k-u-plan__body">
          <span className="sr-only">{t('limits.reading')}</span>
          <span aria-hidden className="k-u-rings--empty" data-reading />
          <span aria-hidden className="k-u-plan__reading">
            <span className="k-u-bone" style={{ width: '80%' }} />
            <span className="k-u-bone" style={{ width: '60%' }} />
          </span>
        </div>
      ) : card.rings.length === 0 ? (
        <div className="k-u-plan__body">
          <span aria-hidden className="k-u-rings--empty" />
          <span className="k-u-plan__none" data-failed={failed || undefined}>
            {failed ? t('limits.neverRead') : t('limits.notYet')}
          </span>
        </div>
      ) : (
        <div className="k-u-plan__body">
          <PlanRings
            rings={[...card.rings].reverse().map((ring) => ({
              id: ring.limit.window,
              percent: ring.percent,
              level: ring.level,
            }))}
            size={RINGS}
            {...ringStroke(card.rings.length, RINGS)}
            className="k-u-rings"
          />
          <div className="k-u-plan__lines">
            {card.rings.map((ring) => {
              const name = limitLabel(ring.limit)
              const reset = resetText(ring, now)
              return (
                <span key={ring.limit.window} className="k-u-plan__line">
                  <span aria-hidden className="k-u-plan__win">
                    {shortName(ring.limit)}
                  </span>
                  <b aria-hidden className="k-num" data-level={ring.level}>
                    {ring.reached && ring.limit.resetsAt! > now
                      ? t('limits.backIn', { time: countdown(ring.limit.resetsAt! - now)! })
                      : `${ring.percent}%`}
                  </b>
                  {reset && <small aria-hidden>{reset}</small>}
                  <span className="sr-only">
                    {t('limits.windowUsed', { window: name, percent: ring.percent })}
                    {reset && ` ${reset}`}
                  </span>
                </span>
              )
            })}
            {failed && card.readAt !== null && (
              <span className="k-u-plan__last">
                {t('limits.lastRead', { ago: longAgo(card.readAt, now) })}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  )
  if (card.rings.length === 0) {
    return (
      <article
        aria-label={card.name}
        className="k-u-card k-u-plan"
        data-failed={failed || undefined}
      >
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
            className="k-u-card k-u-plan"
            data-failed={failed || undefined}
          />
        }
      >
        {face}
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={6} className="w-72">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1.5 text-hint">
          <span className="col-span-3 truncate font-medium text-primary">
            {card.plan ? `${card.name} · ${card.plan}` : card.name}
          </span>
          {card.rings.map((ring) => (
            <span key={ring.limit.window} className="contents">
              <span className="truncate text-tertiary">{limitLabel(ring.limit)}</span>
              <span className="text-right font-medium text-primary tabular-nums">
                {ring.percent}%
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
