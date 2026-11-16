import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Analytics01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { PlanRings } from '@renderer/components/plan-rings'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import {
  accountAgents,
  accountCardKey,
  accountKey,
  ownKey,
  type AccountAgent,
} from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { agentsOn, planReadingsOf, useAgentsStore, usePlanReadings } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { planLimitWays, readLimitsThrough } from '@renderer/stores/usage'
import { openUsage, useViewStore } from '@renderer/stores/view'
import {
  shownHostAgents,
  useHostName,
  useShownHostAgents,
  useWindowHost,
} from '@renderer/stores/window-host'
import { closeAccountMenu } from './menu-close'
import { currentCard, planCards, popoverCards, tightestWindow } from './model'
import { PlanLimitCard } from './plan-limit-card'

/**
 * Reads the plan limits the popover lists again, each account once through one of its hosts; the
 * host asks each agent at most once a minute.
 */
function readLimits(): void {
  const listed = new Set(
    accountAgents(shownHostAgents(), planReadingsOf(useAgentsStore.getState())).map((a) => a.key),
  )
  for (const [key, ways] of planLimitWays()) {
    if (!listed.has(key)) continue
    readLimitsThrough(ways).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
  }
}

/** The window's hosts' accounts with plan limits, an account once however many hosts it is on. */
function useAccountsWithLimits(): AccountAgent[] {
  const shown = useShownHostAgents()
  const readings = usePlanReadings()
  return useMemo(
    () =>
      accountAgents(shown, readings).filter(
        (a) => a.limits.length > 0 || (a.agent.balances?.length ?? 0) > 0,
      ),
    [shown, readings],
  )
}

/** The agent of the session shown, the focused pane's in a split, or New session's choice. */
function useShownAgent(): { hostId: string | null; agentId: AgentId } | null {
  const main = useViewStore((s) => s.main)
  const projectPath = useViewStore((s) => s.projectPath)
  const summary = useSessionsStore((s) =>
    main.kind === 'session' ? s.byId[main.sessionId] : undefined,
  )
  return useMemo(() => {
    if (summary) return { hostId: hostOfSession(summary), agentId: summary.agentId }
    if (main.kind !== 'new' || !main.agentId) return null
    const hostId = main.noProject
      ? null
      : projectPath
        ? hostOfPath(projectPath)
        : (main.hostId ?? null)
    return { hostId, agentId: main.agentId }
  }, [main, projectPath, summary])
}

/**
 * The account the ring follows, by its card key, and its agent's name; on a page with no agent of
 * its own, the one followed last.
 */
function useCurrentAccount(): { key: string; agentName: string } | null {
  const agent = useShownAgent()
  const found = useAgentsStore((s) => {
    if (!agent) return null
    const status = agentsOn(s, agent.hostId).byId[agent.agentId]
    if (!status) return null
    const account = accountKey(status)
    const key = account === null ? ownKey(agent.hostId, agent.agentId) : accountCardKey(account)
    return `${key}\n${status.name}`
  })
  const [kept, setKept] = useState(found)
  if (found !== null && found !== kept) setKept(found)
  const shown = found ?? kept
  if (shown === null) return null
  const cut = shown.lastIndexOf('\n')
  return { key: shown.slice(0, cut), agentName: shown.slice(cut + 1) }
}

/**
 * The account row's plan ring: the current session's account at its tightest window, which opens
 * every account's plan cards where the account menu opens. Gone while no account reports a limit.
 */
export function PlanRing() {
  const { t } = useTranslation(['sidebar', 'composer'])
  const cards = planCards(useAccountsWithLimits(), useNow())
  const current = useCurrentAccount()
  const [open, setOpen] = useState(false)
  if (cards.length === 0) return null

  const card = current ? currentCard(cards, current.key) : null
  const tightest = card?.windows.length ? tightestWindow(card) : null
  const label =
    card && tightest
      ? t('sidebar:account.ring', {
          account: card.name,
          window: tightest.model
            ? `${t(`composer:usage.shortWindow.${tightest.window}`)} ${tightest.model}`
            : t(`composer:usage.shortWindow.${tightest.window}`),
          percent: tightest.percent,
        })
      : current
        ? t('sidebar:account.ringNone', { agent: current.agentName })
        : t('sidebar:account.limits')

  const toggle = () => {
    if (!open) closeAccountMenu()
    setOpen(!open)
  }

  return (
    <span className="kettu-plan-ring">
      <Tooltip>
        <TooltipTrigger
          delay={500}
          render={
            <button
              type="button"
              aria-label={card ? t('sidebar:account.ringButton', { limit: label }) : label}
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={toggle}
              className="ui-as-icon-btn ui-as-user-action kettu-plan-ring__button"
            />
          }
        >
          <PlanRings
            rings={[
              tightest
                ? { id: tightest.id, percent: tightest.percent, level: tightest.level }
                : { id: 'none', percent: 0, level: 'ok' },
            ]}
            size={16}
            stroke={2.5}
            gap={0}
            track="neutral"
            className="size-4"
          />
        </TooltipTrigger>
        {!open && <TooltipContent side="top">{label}</TooltipContent>}
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} side="top" className="ui-as-user-pop">
        {open && <PlanPopover currentKey={card?.key ?? null} close={() => setOpen(false)} />}
      </Popover>
    </span>
  )
}

/** Every account's plan cards on an inset panel, the current one first, then Open Usage. */
function PlanPopover({ currentKey, close }: { currentKey: string | null; close: () => void }) {
  const { t } = useTranslation('sidebar')
  const cards = planCards(useAccountsWithLimits(), useNow())
  const current = cards.find((card) => card.key === currentKey) ?? null
  const { shown, more } = popoverCards(cards, current)
  const windowHost = useWindowHost()
  const hostName = useHostName()
  const shownKey = windowHost.kind === 'all' ? '*' : (windowHost.hostId ?? '')
  useEffect(() => readLimits(), [shownKey])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }, [])

  const open = () => {
    close()
    openUsage()
  }
  // Arrow keys move through the cards and the rows under them, in order.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const next = buttons[(at + step + buttons.length) % buttons.length]
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('account.limits')}
      onKeyDown={onKeyDown}
      className="kettu-plan-pop"
    >
      <div className="kettu-plan-pop__head">
        <span>{t('account.limits')}</span>
        <span className="kettu-plan-pop__host">
          {windowHost.kind === 'all' ? t('hosts.all') : hostName(windowHost.hostId)}
        </span>
      </div>
      <div className="kettu-plan-pop__well">
        <div className="grid grid-cols-2 gap-1">
          {shown.map((card) => (
            <PlanLimitCard key={card.key} card={card} onOpen={open} />
          ))}
        </div>
        {more > 0 && (
          <button type="button" onClick={open} className="kettu-plan-pop__more">
            {t('account.allLimits')}
            <span className="kettu-plan-pop__count">+{more}</span>
            <Icon icon={ArrowRight01Icon} size={12} />
          </button>
        )}
      </div>
      <button type="button" onClick={open} className="kettu-plan-pop__row">
        <Icon icon={Analytics01Icon} size={16} />
        <span className="min-w-0 flex-1 truncate">{t('account.openUsage')}</span>
        <Icon icon={ArrowRight01Icon} size={14} />
      </button>
    </div>
  )
}
