import { useEffect } from 'react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { strongestSignal } from '@renderer/features/routines/model'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { dayOf } from '@renderer/features/usage/model'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import { limitLabel, tokens } from '@renderer/lib/format'
import { LIMIT_TEXT, limitLevel, limitPercent } from '@renderer/lib/plan-limit'
import { formatShortcut } from '@renderer/lib/platform'
import { accountAgents, tightestAccountOf } from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { loadToday, useUsageStore } from '@renderer/stores/usage'
import { usePlanReadings } from '@renderer/stores/agents'
import { useActiveHostId, useShownHostAgents } from '@renderer/stores/window-host'
import { costText } from './usage-row'

// What the sidebar menu's rows end with: New session's shortcut, and the Routines and Usage marks.

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
        className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-attention px-1 text-[11px] leading-none font-semibold text-attention-foreground tabular"
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

/** A row's shortcut, a hint for the eye; the shortcut sheet lists it for everyone. */
export function NavShortcut({ keys }: { keys: string }) {
  return (
    <kbd aria-hidden className={cn('kettu-nav-shortcut font-sans phone:hidden', ROW_END)}>
      {formatShortcut(keys)}
    </kbd>
  )
}

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

/** The tightest limit of the window's hosts' accounts, each at its newest reading. */
export function TightestLimit() {
  const { t } = useTranslation('usage')
  const view = useLimitView()
  const activeHost = useActiveHostId()
  const accounts = accountAgents(useShownHostAgents(), usePlanReadings())
  const tightest = tightestAccountOf(accounts, useNow(), activeHost)
  if (!tightest) return null
  const {
    account: { agent, hostId, name },
    limit,
  } = tightest
  const percent = `${limitPercent(limit, view) ?? 0}%`
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
        {t(view === 'left' ? 'nav.limitShortLeft' : 'nav.limitShort', {
          limit: limitLabel(limit),
          percent,
        })}
      </span>
      <span className="sr-only">
        {t(view === 'left' ? 'nav.limitLeft' : 'nav.limit', {
          agent: name,
          limit: limitLabel(limit),
          percent,
        })}
      </span>
    </span>
  )
}
