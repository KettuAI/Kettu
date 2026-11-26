import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DragDropProvider, PointerSensor, type DragEndEvent } from '@dnd-kit/react'
import { isSortable } from '@dnd-kit/react/sortable'
import { ArrowRight01Icon, PieChartIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ProviderBalance } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { LimitViewSwitch } from '@renderer/components/plan-limit-view'
import { PlanRings } from '@renderer/components/plan-rings'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import { balanceLabel, planBalance, windowShort } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { shownPercent } from '@renderer/lib/plan-limit'
import {
  accountAgents,
  accountCardKey,
  accountKey,
  focusUnidentifiedAccounts,
  ownKey,
  type AccountAgent,
} from '@renderer/lib/plan-readings'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentsOn, planReadingsOf, useAgentsStore, usePlanReadings } from '@renderer/stores/agents'
import { useOverlayPresence } from '@renderer/stores/overlays'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { planLimitWays, readLimitsThrough } from '@renderer/stores/usage'
import { openUsage, useViewStore } from '@renderer/stores/view'
import {
  activeHostId,
  shownHostAgents,
  useActiveHostId,
  useHostName,
  useShownHostAgents,
  useWindowHost,
} from '@renderer/stores/window-host'
import { closeAccountMenu } from './menu-close'
import { balanceTotal, currentCard, planCards, popoverCards, type PlanCard } from './model'
import { PlanLimitCard } from './plan-limit-card'

/**
 * Reads the plan limits the popover lists again, each account once through one of its hosts; the
 * host asks each agent at most once a minute.
 */
function readLimits(): void {
  const accounts = focusUnidentifiedAccounts(
    accountAgents(shownHostAgents(), planReadingsOf(useAgentsStore.getState())),
    activeHostId(),
  )
  const listed = new Set(accounts.map((a) => a.key))
  for (const [key, ways] of planLimitWays()) {
    if (!listed.has(key)) continue
    readLimitsThrough(ways).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
  }
}

/**
 * The window's hosts' accounts with plan limits, an account once however many hosts it is on.
 * Unidentified multi-host harnesses focus onto the active host in compact surfaces.
 */
function useAccountsWithLimits(): AccountAgent[] {
  const shown = useShownHostAgents()
  const readings = usePlanReadings()
  const activeHost = useActiveHostId()
  return useMemo(() => {
    const withLimits = accountAgents(shown, readings).filter(
      (a) => a.limits.length > 0 || (a.agent.balances?.length ?? 0) > 0,
    )
    return focusUnidentifiedAccounts(withLimits, activeHost)
  }, [shown, readings, activeHost])
}

/** The agent of the focused session or New session's choice. */
function useShownAgent(): { hostId: string | null; agentId: AgentId } | null {
  const main = useViewStore((s) => s.main)
  const projectPath = useViewStore((s) => s.projectPath)
  const summary = useSessionsStore((s) =>
    main.kind === 'session' ? s.byId[main.sessionId] : undefined,
  )
  return useMemo(() => {
    if (summary) {
      return { hostId: hostOfSession(summary), agentId: summary.agentId }
    }
    if (main.kind !== 'new' || !main.agentId) return null
    const hostId = main.noProject
      ? null
      : projectPath
        ? hostOfPath(projectPath)
        : (main.hostId ?? null)
    return { hostId, agentId: main.agentId }
  }, [main, projectPath, summary])
}

/** The last account stays selected on pages with no agent of their own. */
function useCurrentAccountKey(): string | null {
  const agent = useShownAgent()
  const key = useAgentsStore((s) => {
    if (!agent) return null
    const status = agentsOn(s, agent.hostId).byId[agent.agentId]
    if (!status) return null
    const account = accountKey(status)
    return account === null ? ownKey(agent.hostId, agent.agentId) : accountCardKey(account)
  })
  const [kept, setKept] = useState(key)
  if (key !== null && key !== kept) setKept(key)
  return key ?? kept
}

/** Rings that fit 20 px, by how many there are. */
function ringSizes(count: number): { stroke: number; gap: number } {
  if (count <= 1) return { stroke: 2.5, gap: 0 }
  if (count === 2) return { stroke: 2.2, gap: 1.2 }
  if (count === 3) return { stroke: 1.8, gap: 1 }
  const scale = 4 / count
  return { stroke: 1.5 * scale, gap: 0.75 * scale }
}

/** A balance in its currency, or in its own units, such as credits, by their shown name. */
function balanceText(
  balance: Omit<ProviderBalance, 'label'>,
  units: Record<string, string>,
): string {
  return planBalance(balance.amount, balance.currency, units[balance.currency] ?? balance.currency)
}

/** The current account's plan windows or balance, with a popover for all accounts. */
export function PlanRing() {
  const { t } = useTranslation(['sidebar', 'composer', 'usage'])
  const cards = planCards(useAccountsWithLimits(), useNow())
  const currentKey = useCurrentAccountKey()
  const windowHost = useWindowHost()
  const hostName = useHostName()
  const view = useLimitView()
  const [open, setOpen] = useState(false)
  useOverlayPresence(open, { dismissible: true })

  const card = currentKey ? currentCard(cards, currentKey) : null
  const windows = card?.windows ?? []
  const balance = card && windows.length === 0 ? balanceTotal(card.balances) : null
  if (!card || (windows.length === 0 && !balance)) return null

  const accountLabel =
    windowHost.kind === 'all' && card.hostScoped
      ? `${card.name} · ${hostName(card.hostId)}`
      : card.name
  const units: Record<string, string> = {
    credits: t('usage:limits.units.credits'),
    requests: t('usage:limits.units.premiumRequests'),
  }
  let label: string
  if (balance) {
    const amount = balanceText(balance, units)
    label =
      balance.wallets.length > 1
        ? t('sidebar:account.ringBalanceWallets', {
            account: accountLabel,
            amount,
            wallets: balance.wallets
              .map((w) => `${balanceLabel(w.label)} ${balanceText(w, units)}`)
              .join(' · '),
          })
        : t('sidebar:account.ringBalance', { account: accountLabel, amount })
  } else {
    label = t('sidebar:account.ring', {
      account: accountLabel,
      windows: [...windows]
        .reverse()
        .map((w) =>
          t(view === 'left' ? 'sidebar:account.ringWindowLeft' : 'sidebar:account.ringWindow', {
            window: windowShort({ kind: w.window, count: null, scope: w.model }),
            percent: shownPercent(w.percent, view),
          }),
        )
        .join(' · '),
    })
  }

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
              aria-label={t('sidebar:account.ringButton', { limit: label })}
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={toggle}
              className={cn(
                'ui-as-icon-btn ui-as-user-action kettu-plan-ring__button',
                balance && 'kettu-plan-ring__button--amount',
              )}
            />
          }
        >
          {balance ? (
            <span className="tabular text-small text-secondary">{balanceText(balance, units)}</span>
          ) : (
            // Rings always show the share used, so a fuller ring is always nearer the limit.
            <PlanRings
              rings={windows.map((w) => ({ id: w.id, percent: w.percent, level: w.level }))}
              size={20}
              {...ringSizes(windows.length)}
              track="neutral"
              className="size-5"
            />
          )}
        </TooltipTrigger>
        {!open && <TooltipContent side="top">{label}</TooltipContent>}
      </Tooltip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        side="top"
        className="ui-as-user-pop kettu-plan-ring__pop"
      >
        {open && <PlanPopover currentKey={card.key} close={() => setOpen(false)} />}
      </Popover>
    </span>
  )
}

/** The popover's buttons that arrow keys step through: the cards and Open Usage. */
const NAVIGABLE = 'button:not([role="radio"])'
const PLAN_CARD_ORDER = 'plan-card-order'
const PLAN_CARD_SENSORS = [PointerSensor]

/** Every account's plan cards on an inset panel, then Open Usage. */
function PlanPopover({ currentKey, close }: { currentKey: string | null; close: () => void }) {
  const { t } = useTranslation('sidebar')
  const cards = planCards(useAccountsWithLimits(), useNow())
  const current = cards.find((card) => card.key === currentKey) ?? null
  const [order, setOrder] = useState(() => {
    const stored = readJson<unknown>(PLAN_CARD_ORDER, [])
    return Array.isArray(stored)
      ? stored.filter((key): key is string => typeof key === 'string')
      : []
  })
  const [draggedCards, setDraggedCards] = useState<PlanCard[] | null>(null)
  const shown = draggedCards ?? popoverCards(cards, current, order)
  const sortable = shown.length > 1
  const sortHint = useId()
  const [announcement, setAnnouncement] = useState('')
  const windowHost = useWindowHost()
  const hostName = useHostName()
  const shownKey = windowHost.kind === 'all' ? '*' : (windowHost.hostId ?? '')
  useEffect(() => readLimits(), [shownKey])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(NAVIGABLE)?.focus({ preventScroll: true })
  }, [])

  const open = () => {
    close()
    openUsage()
  }
  const moveCard = (from: number, to: number) => {
    if (from === to || !shown[from] || !shown[to]) return
    const visible = shown.map((card) => card.key)
    const reordered = [...visible]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    const visibleKeys = new Set(visible)
    const nextVisible = reordered.values()
    // Reordering in a host's view keeps the slots of accounts on other hosts.
    const next = [...new Set([...order, ...visible])].map((key) =>
      visibleKeys.has(key) ? (nextVisible.next().value ?? key) : key,
    )
    setOrder(next)
    writeJson(PLAN_CARD_ORDER, next)
    setAnnouncement(t('account.cardMoved', { name: shown[from].name, position: to + 1 }))
  }
  const finishDrag = (event: DragEndEvent) => {
    setDraggedCards(null)
    const source = event.operation.source
    if (!event.canceled && isSortable(source)) moveCard(source.initialIndex, source.index)
  }
  // Arrow keys move through the cards and the rows under them, in order; the Used / Left switch
  // keeps its own arrow keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step || draggedCards || (event.target as HTMLElement).closest('[role="radiogroup"]'))
      return
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>(NAVIGABLE) ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    if (event.altKey) {
      if (!sortable || at < 0 || at >= shown.length) return
      event.preventDefault()
      moveCard(at, at + step)
      const button = buttons[at]
      requestAnimationFrame(() => button.focus())
      return
    }
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
        <LimitViewSwitch />
      </div>
      {sortable && (
        <span id={sortHint} className="sr-only">
          {t('account.reorderCards')}
        </span>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <div className="kettu-plan-pop__well scroll-fade-y">
        <DragDropProvider
          sensors={PLAN_CARD_SENSORS}
          onDragStart={() => setDraggedCards(shown)}
          onDragEnd={finishDrag}
        >
          <div className="grid grid-cols-2 gap-1">
            {shown.map((card, index) => (
              <PlanLimitCard
                key={card.key}
                card={card}
                index={index}
                sortHint={sortable ? sortHint : undefined}
                dragging={draggedCards !== null}
                onOpen={open}
              />
            ))}
          </div>
        </DragDropProvider>
      </div>
      <button type="button" onClick={open} className="kettu-plan-pop__row">
        <Icon icon={PieChartIcon} size={16} />
        <span className="min-w-0 flex-1 truncate">{t('account.openUsage')}</span>
        <Icon icon={ArrowRight01Icon} size={14} />
      </button>
    </div>
  )
}
