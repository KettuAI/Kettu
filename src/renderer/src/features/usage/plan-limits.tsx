import { useEffect, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  Clock01Icon,
  InformationCircleIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PlanLimit, ProviderBalance } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { LimitViewSwitch } from '@renderer/components/plan-limit-view'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useHostInfo } from '@renderer/features/session/composer/host-info'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { countdown, planReset } from '@renderer/features/sidebar/plan-usage'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import {
  balanceLabel,
  limitLabel,
  limitLength,
  limitShort,
  longAgo,
  monthDayTime,
  planAmount,
  planBalance,
  resetDay,
  resetTime,
  shortAgo,
} from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { shownPercent } from '@renderer/lib/plan-limit'
import type { LimitWay } from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { agentsOn, isInstalled, useAgentsStore, usePlanReadings } from '@renderer/stores/agents'
import { planLimitWays, readLimitsThrough } from '@renderer/stores/usage'
import {
  useHostName,
  useShownHostAgents,
  useWindowHost,
  useWindowHostAway,
} from '@renderer/stores/window-host'
import {
  planColumns,
  resetsAhead,
  ringStroke,
  usageCards,
  windowPace,
  type CardRing,
  type LimitRead,
  type UsageCard,
  type WindowPace,
} from './plan-cards'
import { SpendResetDialog } from './spend-reset'
import { wholePercent } from './text'

const RINGS = 80
/** A reading this old says on its card how long ago it was taken. */
const STALE = 60 * 60_000
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** Up to this many windows, each gets a second line with its reset. */
const TWO_LINES = 2

/** A time ahead in one unit or two at most, rounded to the hour past one: "42m", "2h", "1d 5h". */
function roughly(ms: number): string {
  return (ms < HOUR ? countdown(ms) : countdown(Math.round(ms / HOUR) * HOUR)) ?? ''
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
  const shownHosts = useShownHostAgents()
  const readings = usePlanReadings()
  const away = useWindowHostAway() !== null
  // Read afresh when the page opens, unless the host is away: an account once, through one of its
  // computers; the host asks each agent at most once a minute.
  const [toRead] = useState(() => {
    if (away) return new Map<string, LimitWay[]>()
    const shownKeys = new Set(
      usageCards(shownHosts, readings, {}, {}, Date.now()).cards.map((c) => c.key),
    )
    return new Map([...planLimitWays()].filter(([key]) => shownKeys.has(key)))
  })
  const [reads, setReads] = useState<Partial<Record<string, LimitRead>>>(() =>
    Object.fromEntries([...toRead.keys()].map((key) => [key, 'reading' as const])),
  )
  const [open, setOpen] = useState(false)
  useEffect(() => {
    for (const [key, ways] of toRead) {
      readLimitsThrough(ways).then(
        () =>
          setReads((was) => {
            const next = { ...was }
            delete next[key]
            return next
          }),
        (error: unknown) => {
          console.warn(`Could not read the plan limits: ${errorMessage(error)}`)
          setReads((was) => ({ ...was, [key]: 'failed' }))
        },
      )
    }
  }, [toRead])
  const { cards, unreported } = usageCards(shownHosts, readings, used, reads, now)
  const view = useLimitView()
  const named = shownHosts.length > 1
  const read = Math.max(0, ...cards.map((card) => card.readAt ?? 0))
  const names = new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
    unreported.map((a) => a.name),
  )
  // The resets after the cards are one more card, while any card has a window.
  const resets = cards.some((card) => card.rings.length > 0) ? resetsAhead(cards, now) : null
  const columns = planColumns(cards.length + (resets ? 1 : 0))
  const fold = columns * 2 - (resets ? 1 : 0)
  const shown = open || cards.length <= fold ? cards : cards.slice(0, fold)
  const hidden = cards.slice(fold)
  const near = hidden.filter((card) =>
    card.rings.some((ring) => ring.level === 'warn' || ring.level === 'bad'),
  ).length
  const paced =
    view === 'used' &&
    cards.some((card) => card.rings.some((ring) => windowPace(ring.limit, now) !== null))
  const head = [
    cards.length > 0 ? t('limits.accounts', { count: cards.length }) : null,
    read > 0 ? t('limits.read', { ago: longAgo(read, now) }) : null,
  ].filter(Boolean)
  return (
    <section className="k-u-sec k-u-span-12" aria-labelledby="plan-limits-title">
      <header className="k-u-sec__head">
        <h2 id="plan-limits-title">{t('limits.title')}</h2>
        {head.length > 0 && <span className="k-u-meta">{head.join(' · ')}</span>}
        <span className="k-u-sec__keys">
          {paced && (
            <span className="k-u-key">
              <PassedKey />
              {t('limits.passedKey')}
            </span>
          )}
          {unreported.length > 0 && (
            <span
              className="k-u-key"
              title={t('limits.notReported', { name: names, count: unreported.length })}
            >
              <Icon icon={InformationCircleIcon} size={13} />
              <span className="k-u-key__text">
                {t('limits.notReported', { name: names, count: unreported.length })}
              </span>
            </span>
          )}
          {cards.length > 0 && <LimitViewSwitch />}
        </span>
      </header>
      {cards.length === 0 ? (
        <div className="k-u-card k-u-pad">
          <p className="k-u-none">{t('limits.none')}</p>
        </div>
      ) : (
        <div className="k-u-plans" data-cols={columns}>
          {shown.map((card) => (
            <PlanCard key={card.key} card={card} named={named} now={now} />
          ))}
          {resets && <ResetsAhead resets={resets} now={now} />}
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
    </section>
  )
}

/** The legend's ring: its track, the part passed a step darker, and a short use. */
function PassedKey() {
  return (
    <PlanRings
      rings={[{ id: 'key', percent: 25, level: 'ok', passed: 0.62 }]}
      size={13}
      stroke={2.6}
      gap={0}
      className="k-u-key__ring"
    />
  )
}

/**
 * The windows that reset within the next week, the soonest first, each with its account and how
 * much of it is used; a used-up one in the error color.
 */
function ResetsAhead({ resets, now }: { resets: ReturnType<typeof resetsAhead>; now: number }) {
  const { t } = useTranslation('usage')
  const view = useLimitView()
  const hostName = useHostName()
  return (
    <section className="k-u-card k-u-resets" aria-labelledby="resets-ahead-title">
      <header className="k-u-card__head">
        <h3 id="resets-ahead-title">{t('limits.resets.title')}</h3>
        <span className="k-u-meta">{t('limits.resets.next')}</span>
      </header>
      {resets.length === 0 ? (
        <p className="k-u-resets__none">{t('limits.resets.none')}</p>
      ) : (
        <ol className="k-u-resets__list">
          {resets.map(({ key, card, ring, at }) => {
            const when = at - now < DAY ? countdown(at - now) : resetTime(at, now)
            const window = limitShort(ring.limit, ' · ')
            const percent = shownPercent(ring.percent, view)
            const host = card.showHostLabel ? hostName(card.hostId) : null
            const whoLabel = host ? `${card.name} (${host})` : card.name
            return (
              <Tooltip key={key}>
                <TooltipTrigger
                  render={
                    <li
                      className="k-u-resets__row"
                      data-level={ring.level}
                      data-host={host !== null || undefined}
                      aria-label={t('limits.resets.row', {
                        window: `${whoLabel} · ${limitLabel(ring.limit)}`,
                        time: monthDayTime(at),
                        percent: t(view === 'left' ? 'limits.percentLeft' : 'limits.percentUsed', {
                          percent,
                        }),
                      })}
                    />
                  }
                >
                  <span aria-hidden className="k-u-resets__pin" />
                  <b aria-hidden className="k-num">
                    {when}
                  </b>
                  {host ? (
                    <span aria-hidden className="k-u-resets__who k-u-resets__who--stacked">
                      <AgentMark agent={card.agentId} hostId={card.hostId} size={13} />
                      <span className="k-u-resets__stack">
                        <span>{`${card.name} · ${window}`}</span>
                        <span className="k-u-resets__sub">{host}</span>
                      </span>
                    </span>
                  ) : (
                    <span aria-hidden className="k-u-resets__who">
                      <AgentMark agent={card.agentId} hostId={card.hostId} size={13} />
                      <span>{`${card.name} · ${window}`}</span>
                    </span>
                  )}
                  <span aria-hidden className="k-num k-u-resets__pct" data-level={ring.level}>
                    {percent}%
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {`${host ? `${host} · ` : ''}${limitLabel(ring.limit)} · ${monthDayTime(at)}`}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/**
 * An account's card: its mark, name and tier, then a ring per window beside a line per window,
 * the longest outside and first; then a line of the next reset and what the account holds beyond
 * its windows, and with several computers shown, a line of those it is on. A reading over an hour
 * old says how long ago it was taken, on that line or else beside the name. Hovered or focused,
 * it lists when each window resets and what each computer calls the account.
 */
function PlanCard({ card, named, now }: { card: UsageCard; named: boolean; now: number }) {
  const { t } = useTranslation('usage')
  const hostName = useHostName()
  const hostInfo = useHostInfo(card.hostId)
  const host = hostName(card.hostId)
  const installed = useAgentsStore((s) => {
    const agent = agentsOn(s, card.hostId).byId[card.agentId]
    return agent ? isInstalled(agent) : true
  })
  const failed = card.state === 'failed'
  const [spending, setSpending] = useState(false)
  const resets = card.resets
  const view = useLimitView()
  const where = [...new Set(card.places.map((place) => hostName(place.hostId)))]
  const cardLabel = [card.name, card.showHostLabel ? host : null, card.plan]
    .filter(Boolean)
    .join(', ')
  const hoverTitle = [card.name, card.showHostLabel ? host : null, card.plan]
    .filter(Boolean)
    .join(' · ')
  const amountOf = (balance: ProviderBalance): string =>
    planBalance(
      balance.amount,
      balance.currency,
      balance.currency === 'credits'
        ? t('limits.units.credits')
        : balance.currency === 'requests'
          ? t('limits.units.premiumRequests')
          : balance.currency,
    )
  const balanceRows = (card.balances ?? []).map((balance) => (
    <span key={`${balance.label}/${balance.currency}`} className="k-u-plan__balance">
      <span>{balanceLabel(balance.label)}</span>
      <b>{amountOf(balance)}</b>
    </span>
  ))
  // With windows, balances leave their lines for the card's end line; without, they stay by the ring.
  const holds = card.rings.length > 0 ? (card.balances ?? []) : []
  const credits = resets && resets.count > 0 ? resets : null
  const creditsText =
    credits &&
    `${t('resets.count', { count: credits.count })} · ${
      credits.each === null
        ? t('resets.unknown')
        : credits.each[0]!.until === null
          ? t('resets.never')
          : t('resets.until', { time: monthDayTime(credits.each[0]!.until) })
    }`
  const next: PlanLimit | undefined = card.rings
    .map((ring) => ring.limit)
    .filter((limit) => limit.resetsAt !== null && limit.resetsAt > now)
    .sort((a, b) => a.resetsAt! - b.resetsAt!)[0]
  const nextText =
    next &&
    t('limits.nextReset', {
      window: limitLabel(next),
      // Past six days resetTime gives the day alone, and the tooltip names the time too.
      time:
        next.resetsAt! - now < 6 * DAY
          ? resetTime(next.resetsAt!, now)
          : monthDayTime(next.resetsAt!),
    })
  const age = !failed && card.readAt !== null && now - card.readAt > STALE && (
    <span className="k-u-plan__age" title={t('limits.read', { ago: longAgo(card.readAt, now) })}>
      <Icon icon={Clock01Icon} size={12} />
      <span aria-hidden>{shortAgo(card.readAt, now)}</span>
      <span className="sr-only">{t('limits.read', { ago: longAgo(card.readAt, now) })}</span>
    </span>
  )
  const face = (
    <>
      <div className="k-u-plan__head">
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
        {card.showHostLabel && (
          <span className="k-u-plan__host">
            <HostIcon platform={hostInfo.platform} className="k-u-plan__host-icon" />
            <span>{host}</span>
          </span>
        )}
      </div>
      {card.state === 'reading' ? (
        <div aria-busy className="k-u-plan__body">
          <span className="sr-only">{t('limits.reading')}</span>
          <span aria-hidden className="k-u-rings--empty" data-reading />
          <span aria-hidden className="k-u-plan__reading">
            <span className="k-u-bone" style={{ width: '80%' }} />
            <span className="k-u-bone" style={{ width: '60%' }} />
            {balanceRows}
          </span>
        </div>
      ) : card.rings.length === 0 ? (
        <div className="k-u-plan__body">
          <span aria-hidden className="k-u-rings--empty" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="k-u-plan__none" data-failed={failed || undefined}>
              {failed ? t('limits.neverRead') : t('limits.notYet')}
            </span>
            {balanceRows}
          </span>
        </div>
      ) : (
        <div className="k-u-plan__body">
          <PlanRings
            rings={[...card.rings].reverse().map((ring) => ({
              id: ring.limit.window,
              percent: shownPercent(ring.percent, view),
              level: ring.level,
              passed: view === 'used' ? windowPace(ring.limit, now)?.passed : null,
            }))}
            size={RINGS}
            {...ringStroke(card.rings.length, RINGS)}
            className="k-u-rings"
          />
          <div className="k-u-plan__lines" data-two={card.rings.length <= TWO_LINES || undefined}>
            {card.rings.map((ring) => (
              <WindowLine
                key={ring.limit.window}
                ring={ring}
                now={now}
                second={card.rings.length <= TWO_LINES}
              />
            ))}
            {failed && card.readAt !== null && (
              <span className="k-u-plan__last">
                {t('limits.lastRead', { ago: longAgo(card.readAt, now) })}
              </span>
            )}
          </div>
        </div>
      )}
      {resets?.error && <span className="k-u-plan__last">{t(`resets.error.${resets.error}`)}</span>}
      {(card.rings.length > 0 || credits) && (
        <div className="k-u-plan__end">
          {next ? (
            <span className="k-u-plan__next" title={nextText}>
              <Icon icon={Clock01Icon} size={13} />
              <b aria-hidden className="k-num">
                {next.resetsAt! - now < DAY
                  ? countdown(next.resetsAt! - now)
                  : resetTime(next.resetsAt!, now)}
              </b>
              <span aria-hidden>· {limitLength(next)}</span>
              <span className="sr-only">{nextText}</span>
            </span>
          ) : (
            card.rings.length > 0 && (
              <span className="k-u-plan__next">
                <Icon icon={Clock01Icon} size={13} />
                <span>{t('limits.notStarted')}</span>
              </span>
            )
          )}
          <span className="k-u-plan__extras">
            {holds.map((balance) => (
              <span
                key={`${balance.label}/${balance.currency}`}
                className="k-u-plan__extra"
                title={`${balanceLabel(balance.label)} ${amountOf(balance)}`}
              >
                <span>{balanceLabel(balance.label)}</span>
                <b className="k-num">{amountOf(balance)}</b>
              </span>
            ))}
            {credits && (
              <span className="k-u-plan__extra" title={creditsText!}>
                <Icon icon={ArrowReloadHorizontalIcon} size={13} />
                <b aria-hidden className="k-num">
                  {credits.count}
                </b>
                <span className="sr-only">{creditsText}</span>
              </span>
            )}
            {credits?.each && (
              <button
                type="button"
                className="k-u-plan__use"
                onClick={(event) => {
                  event.stopPropagation()
                  setSpending(true)
                }}
              >
                {t('resets.use')}
              </button>
            )}
          </span>
        </div>
      )}
      {named && (
        <footer className="k-u-plan__foot">
          <span className="k-u-plan__where">
            {card.showHostLabel ? t('limits.perHost') : where.join(' · ')}
          </span>
          {age}
        </footer>
      )}
    </>
  )
  const dialog = spending && resets?.each && resets.each.length > 0 && (
    <SpendResetDialog
      account={card.email ?? card.name}
      resets={resets}
      each={resets.each}
      onClose={() => setSpending(false)}
    />
  )
  if (card.rings.length === 0) {
    return (
      <article
        aria-label={cardLabel}
        className="k-u-card k-u-plan"
        data-failed={failed || undefined}
      >
        {face}
        {dialog}
      </article>
    )
  }
  return (
    <>
      {dialog}
      <HoverCard>
        <HoverCardTrigger
          delay={150}
          closeDelay={100}
          render={
            <article
              tabIndex={0}
              aria-label={cardLabel}
              className="k-u-card k-u-plan"
              data-failed={failed || undefined}
            />
          }
        >
          {face}
        </HoverCardTrigger>
        <HoverCardContent side="bottom" align="start" sideOffset={6} className="w-80">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1.5 text-hint">
            <span className="col-span-3 truncate font-medium text-primary">{hoverTitle}</span>
            {card.rings.map((ring) => {
              const pace = windowPace(ring.limit, now)
              return (
                <span key={ring.limit.window} className="contents">
                  <span className="text-tertiary">{limitLabel(ring.limit)}</span>
                  <span className="text-right font-medium text-primary tabular-nums">
                    {shownPercent(ring.percent, view)}%
                  </span>
                  <span className="text-right whitespace-nowrap text-secondary">
                    {ring.limit.resetsAt === null ? '' : planReset(ring.limit.resetsAt, now)}
                  </span>
                  {pace && !ring.reached && (
                    <span
                      className="col-span-3 -mt-1 truncate text-tertiary data-out:text-(--plan-bad-text)"
                      data-out={pace.outAt !== null || undefined}
                    >
                      <PaceText pace={pace} ring={ring} now={now} />
                    </span>
                  )}
                </span>
              )
            })}
            {resets?.each?.map((credit, index) => (
              <span key={credit.id} className="contents">
                <span className="col-span-2 truncate text-tertiary">
                  {index === 0 ? t('resets.count', { count: resets.count }) : ''}
                </span>
                <span className="text-right whitespace-nowrap text-secondary">
                  {credit.until === null
                    ? t('resets.never')
                    : t('resets.until', { time: monthDayTime(credit.until) })}
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
    </>
  )
}

/**
 * A window's line: its short name and percentage, or when it comes back once used up. With room,
 * a second line says when it resets; one that runs out before its reset at its pace says when,
 * in the error color, in place of that line or as a second line of its own.
 */
function WindowLine({ ring, now, second }: { ring: CardRing; now: number; second: boolean }) {
  const { t } = useTranslation('usage')
  const view = useLimitView()
  const name = limitLabel(ring.limit)
  const resetsAt = ring.limit.resetsAt
  const reset = resetsAt === null ? null : planReset(resetsAt, now)
  const pace = ring.reached ? null : windowPace(ring.limit, now)
  const out =
    pace?.outAt != null && resetsAt !== null
      ? t('limits.outIn', { time: roughly(pace.outAt - now), day: resetDay(resetsAt, now) })
      : null
  const unit =
    ring.limit.amount?.unit === 'credits'
      ? t('limits.units.credits')
      : ring.limit.amount?.unit === 'requests'
        ? t('limits.units.premiumRequests')
        : ring.limit.amount?.unit
  const below = out ?? (second ? reset : null)
  return (
    <div className="k-u-plan__window">
      <span className="k-u-plan__line">
        <span aria-hidden className="k-u-plan__win">
          {limitShort(ring.limit, ' · ')}
        </span>
        <b aria-hidden className="k-num" data-level={ring.level}>
          {ring.reached && resetsAt! > now
            ? t('limits.backIn', { time: countdown(resetsAt! - now)! })
            : `${shownPercent(ring.percent, view)}%`}
        </b>
        {reset && !below && <small aria-hidden>{reset}</small>}
        <span className="sr-only">
          {t(view === 'left' ? 'limits.windowLeft' : 'limits.windowUsed', {
            window: name,
            percent: shownPercent(ring.percent, view),
          })}
          {` ${out ?? reset ?? ''}`}
        </span>
      </span>
      {below && (
        <span aria-hidden className="k-u-plan__below" data-out={out !== null || undefined}>
          {below}
        </span>
      )}
      {ring.limit.amount && (
        <span className="k-u-plan__amount">
          {planAmount(
            ring.limit.amount.used,
            ring.limit.amount.total,
            ring.limit.amount.unit,
            unit ?? ring.limit.amount.unit,
          )}
        </span>
      )}
    </div>
  )
}

/** Where a window's use heads at its pace so far: how much of it has passed, then by when. */
function PaceText({ pace, ring, now }: { pace: WindowPace; ring: CardRing; now: number }) {
  const { t } = useTranslation('usage')
  const passed = t('limits.pace.passed', { share: wholePercent(pace.passed) })
  if (pace.outAt !== null && ring.limit.resetsAt !== null) {
    return (
      <>
        {passed} ·{' '}
        {t('limits.pace.out', {
          time: roughly(pace.outAt - now),
          back: resetTime(ring.limit.resetsAt, now),
        })}
      </>
    )
  }
  if (pace.projected === null) return <>{passed}</>
  return (
    <>
      {passed} · {t('limits.pace.heads', { percent: Math.round(Math.min(100, pace.projected)) })}
    </>
  )
}
