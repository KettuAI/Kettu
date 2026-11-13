import { useEffect, useMemo, useState } from 'react'
import { ArrowDown01Icon, Clock01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { countdown, planReset } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo, shortAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { agentsOn, isInstalled, useAgentsStore, type HostAgents } from '@renderer/stores/agents'
import { otherHosts, useHostsStore, useOtherHosts } from '@renderer/stores/hosts'
import { useHostName, useWindowHost, useWindowHostAway } from '@renderer/stores/window-host'
import { refreshLimits } from '@renderer/stores/usage'
import {
  limitWays,
  newestReadings,
  planColumns,
  ringStroke,
  usageCards,
  type CardRing,
  type HostAgentList,
  type LimitRead,
  type LimitWay,
  type UsageCard,
} from './plan-cards'

const RINGS = 72
/** A reading this old says on its card how long ago it was taken. */
const STALE = 60 * 60_000

const listed = (agents: HostAgents): AgentStatus[] =>
  agents.order
    .map((id) => agents.byId[id])
    .filter((a): a is AgentStatus => !!a && a.registered !== false && !a.disabled)

/** Whether a computer answers now: this one always, another while it is online. */
function reachable(hostId: string | null): boolean {
  if (hostId === null) return true
  const host = otherHosts(useHostsStore.getState()).find((h) => h.id === hostId)
  return host?.connection.state === 'online'
}

/**
 * The plans as they stand, across the page: a card per account that reports limits, as many to
 * a row as leave the last row fullest, then one line for the agents with usage that report none.
 * Past two full rows the rest folds away, so the page's own figures stay in view. They are the
 * shown hosts', an account once however many computers it is signed in on, with its newest
 * reading from any of them.
 */
export function PlanLimits({ used }: { used: Readonly<Record<string, readonly AgentId[]>> }) {
  const host = useWindowHost()
  // Each choice of hosts reads its limits afresh.
  return <HostPlanLimits key={host.kind === 'all' ? '*' : (host.hostId ?? '')} used={used} />
}

function HostPlanLimits({ used }: { used: Readonly<Record<string, readonly AgentId[]>> }) {
  const { t } = useTranslation('usage')
  const now = useNow()
  const windowHost = useWindowHost()
  const others = useOtherHosts()
  const everyHost = useMemo(() => [null, ...others.map((h) => h.id)], [others])
  const lists = useAgentsStore(useShallow((s) => everyHost.map((id) => agentsOn(s, id))))
  const hosts: HostAgentList[] = everyHost.map((hostId, index) => ({
    hostId,
    agents: listed(lists[index]!),
  }))
  const shownHosts = hosts.filter((h) =>
    windowHost.kind === 'all' ? true : h.hostId === windowHost.hostId,
  )
  const away = useWindowHostAway() !== null
  // Read afresh when the page opens, unless the host is away: an account once, through one of its
  // computers; the host asks each agent at most once a minute.
  const [toRead] = useState(() => {
    if (away) return new Map<string, LimitWay[]>()
    const shownKeys = new Set(
      usageCards(shownHosts, newestReadings(hosts), {}, {}, Date.now()).cards.map((c) => c.key),
    )
    return new Map([...limitWays(hosts, reachable)].filter(([key]) => shownKeys.has(key)))
  })
  const [reads, setReads] = useState<Partial<Record<string, LimitRead>>>(() =>
    Object.fromEntries([...toRead.keys()].map((key) => [key, 'reading' as const])),
  )
  const [open, setOpen] = useState(false)
  useEffect(() => {
    for (const [key, ways] of toRead) {
      void (async () => {
        let error: unknown = null
        for (const way of ways) {
          try {
            await refreshLimits(way.agentId, way.hostId)
            error = null
            break
          } catch (failed) {
            error = failed
          }
        }
        if (error === null) {
          setReads((was) => {
            const next = { ...was }
            delete next[key]
            return next
          })
          return
        }
        console.warn(`Could not read the plan limits: ${errorMessage(error)}`)
        setReads((was) => ({ ...was, [key]: 'failed' }))
      })()
    }
  }, [toRead])
  const { cards, unreported } = usageCards(shownHosts, newestReadings(hosts), used, reads, now)
  const named = shownHosts.length > 1
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
            <PlanCard key={card.key} card={card} named={named} now={now} />
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

/**
 * An account's card: its mark, name and tier, then a ring per window beside a line per window,
 * the longest outside and first, and with several computers shown, a line of those it is on. A
 * reading over an hour old says how long ago it was taken, on that line or else beside the name.
 * Hovered or focused, it lists when each window resets and what each computer calls the account.
 */
function PlanCard({ card, named, now }: { card: UsageCard; named: boolean; now: number }) {
  const { t } = useTranslation('usage')
  const hostName = useHostName()
  const installed = useAgentsStore((s) => {
    const agent = agentsOn(s, card.hostId).byId[card.agentId]
    return agent ? isInstalled(agent) : true
  })
  const failed = card.state === 'failed'
  const shortName = useShortWindow()
  const where = [...new Set(card.places.map((place) => hostName(place.hostId)))]
  const age = !failed && card.readAt !== null && now - card.readAt > STALE && (
    <span className="k-u-plan__age" title={t('limits.read', { ago: longAgo(card.readAt, now) })}>
      <Icon icon={Clock01Icon} size={12} />
      <span aria-hidden>{shortAgo(card.readAt, now)}</span>
      <span className="sr-only">{t('limits.read', { ago: longAgo(card.readAt, now) })}</span>
    </span>
  )
  const face = (
    <>
      <header>
        <AgentMark agent={card.agentId} hostId={card.hostId} size={16} mono={!installed} />
        <b>{card.name}</b>
        {!named && age}
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
              const reset =
                ring.limit.resetsAt === null ? null : planReset(ring.limit.resetsAt, now)
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
      {named && (
        <footer className="k-u-plan__foot">
          <span className="k-u-plan__where">{where.join(' · ')}</span>
          {age}
        </footer>
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
                {ring.limit.resetsAt === null ? '' : planReset(ring.limit.resetsAt, now)}
              </span>
            </span>
          ))}
          {card.places.length > 1 &&
            card.places.map((place) => (
              <span
                key={`${place.hostId ?? ''}/${place.agentId}`}
                className="col-span-3 truncate text-tertiary"
              >
                {`${hostName(place.hostId)} · ${place.agentName}`}
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
