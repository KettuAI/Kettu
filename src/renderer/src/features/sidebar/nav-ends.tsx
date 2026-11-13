import { useEffect } from 'react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PlanLimit } from '@shared/agent-host'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { strongestSignal } from '@renderer/features/routines/model'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { dayOf } from '@renderer/features/usage/model'
import { limitLabel, tokens } from '@renderer/lib/format'
import { LIMIT_TEXT, limitLevel } from '@renderer/lib/plan-limit'
import { accountAgents, type AccountAgent } from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { loadToday, useUsageStore } from '@renderer/stores/usage'
import { usePlanReadings } from '@renderer/stores/agents'
import { useShownHostAgents } from '@renderer/stores/window-host'
import { tightestLimit } from './plan-usage'
import { costText } from './usage-row'

// The marks at the end of the sidebar menu's Routines and Usage rows.

/** The routines' strongest signal, as a session row draws its own; runs waiting are counted. */
export function RoutineSignalMark({
  signal,
}: {
  signal: NonNullable<ReturnType<typeof strongestSignal>>
}) {
  if (signal.kind === 'waiting') {
    return (
      <span
        aria-hidden
        className="ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-attention px-[5px] text-meta font-semibold text-attention-foreground tabular"
      >
        {signal.count}
      </span>
    )
  }
  return (
    <span aria-hidden className="ml-auto grid size-4 shrink-0 place-items-center">
      {signal.kind === 'failed' ? (
        <Glyph icon={Alert02Icon} size={14} className="text-danger" />
      ) : signal.kind === 'running' ? (
        <TurnDots phase="working" />
      ) : (
        <span className="size-2 rounded-full bg-current text-tertiary" />
      )}
    </span>
  )
}

const ROW_END = 'ml-auto shrink-0 text-[12px] font-normal text-(--faint) tabular-nums'

export function TodayTokens() {
  const { t } = useTranslation('usage')
  const today = useUsageStore((s) => s.today)
  const day = dayOf(useNow())
  // A new day starts from nothing, whether or not a turn ends to say so.
  useEffect(() => void loadToday(), [day])
  // Quiet until there is something to count.
  if (!today) return null
  return (
    <span className={ROW_END}>
      <span aria-hidden>{tokens(today)}</span>
      <span className="sr-only">{t('nav.today', { tokens: tokens(today) })}</span>
    </span>
  )
}

export function TodayCost() {
  const { t } = useTranslation('usage')
  const cost = useUsageStore((s) => s.todayCost)
  const day = dayOf(useNow())
  // A new day starts from nothing, whether or not a turn ends to say so.
  useEffect(() => void loadToday(), [day])
  const text = costText(cost)
  // Quiet until there is something to show.
  if (!text) return null
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={ROW_END} />} delay={700}>
        <span aria-hidden>{text}</span>
        <span className="sr-only">{t('nav.todayCost', { cost: text })}</span>
      </TooltipTrigger>
      <TooltipContent>{t('nav.costEstimate')}</TooltipContent>
    </Tooltip>
  )
}

/** Across the accounts, a reached window first, then the fullest. */
function tightestOf(
  accounts: readonly AccountAgent[],
  now: number,
): { account: AccountAgent; limit: PlanLimit } | null {
  let best: { account: AccountAgent; limit: PlanLimit } | null = null
  for (const account of accounts) {
    const limit = tightestLimit(account.limits, now)
    if (!limit || limit.usedPercent === null) continue
    const rank = (l: PlanLimit) => (l.state === 'reached' ? 1000 : 0) + (l.usedPercent ?? 0)
    if (!best || rank(limit) > rank(best.limit)) best = { account, limit }
  }
  return best
}

/** The tightest limit of the window's hosts' accounts, each at its newest reading. */
export function TightestLimit() {
  const { t } = useTranslation('usage')
  const accounts = accountAgents(useShownHostAgents(), usePlanReadings())
  const tightest = tightestOf(accounts, useNow())
  if (!tightest) return null
  const {
    account: { agent, hostId, name },
    limit,
  } = tightest
  const percent = `${Math.round(limit.usedPercent ?? 0)}%`
  const level = limitLevel(limit)
  return (
    <span
      className={cn(
        'ml-auto flex min-w-0 shrink-0 items-center gap-1 text-[12px] font-normal tabular-nums',
        level === 'ok' ? 'text-(--faint)' : LIMIT_TEXT[level],
      )}
    >
      <AgentMark agent={agent.id} size={12} hostId={hostId} />
      <span aria-hidden className="truncate">
        {t('nav.limitShort', { limit: limitLabel(limit), percent })}
      </span>
      <span className="sr-only">
        {t('nav.limit', { agent: name, limit: limitLabel(limit), percent })}
      </span>
    </span>
  )
}
