import { useTranslation } from 'react-i18next'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { PlanPart } from '@renderer/features/session/composer/usage'
import { ringStroke } from '@renderer/features/usage/plan-cards'
import { planAmount, planBalance } from '@renderer/lib/format'
import { LIMIT_TEXT } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'
import { useHostName, useWindowHost } from '@renderer/stores/window-host'
import type { PlanCard } from './model'

/**
 * An account's plan windows: its rings and, from the outer ring in, each window's figure. It
 * opens the Usage page; hovered or focused, it shows every window beside it.
 */
export function PlanLimitCard({ card, onOpen }: { card: PlanCard; onOpen: () => void }) {
  const hostName = useHostName()
  // With every host shown, which of them the account is on.
  const hosts = useWindowHost().kind === 'all' ? card.hostIds.map(hostName).join(' · ') : null
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={100}
        closeDelay={100}
        render={
          <button
            type="button"
            onClick={onOpen}
            className="kettu-plan-card min-w-0 rounded-tile outline-none select-none"
          />
        }
      >
        <CardFace card={card} />
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={6} className="w-68">
        <div className="mb-2.5 flex min-w-0 items-center gap-1.5">
          <AgentTile agent={card.agentId} hostId={card.hostId} size={18} />
          <span className="min-w-0 truncate text-small font-semibold text-primary">
            {card.agentName}
          </span>
          {hosts && (
            <span className="ml-auto min-w-0 shrink truncate text-hint text-tertiary">{hosts}</span>
          )}
        </div>
        <PlanPart limits={card.limits} account={card.account} />
      </HoverCardContent>
    </HoverCard>
  )
}

function CardFace({ card }: { card: PlanCard }) {
  const { t } = useTranslation(['sidebar', 'composer', 'common', 'usage'])
  const count = card.windows.length
  const amounts = card.windows.flatMap((window) => {
    if (!window.amount) return []
    const unit =
      window.amount.unit === 'credits'
        ? t('usage:limits.units.credits')
        : window.amount.unit === 'requests'
          ? t('usage:limits.units.premiumRequests')
          : window.amount.unit
    const amount = planAmount(window.amount.used, window.amount.total, window.amount.unit, unit)
    return [{ id: window.id, amount }]
  })
  return (
    <>
      <span className="flex h-4 min-w-0 items-center gap-1.25">
        <AgentMark agent={card.agentId} hostId={card.hostId} size={14} />
        <span className="min-w-0 truncate text-small font-medium text-primary">{card.name}</span>
        {card.tier && (
          <span className="ml-auto shrink-0 text-badge leading-3.75 font-medium text-tertiary">
            {card.tier}
          </span>
        )}
      </span>
      <span className="mt-1.75 flex min-w-0 items-center gap-2.25">
        {count > 0 ? (
          <PlanRings
            rings={card.windows.map((w) => ({ id: w.id, percent: w.percent, level: w.level }))}
            size={36}
            {...(count > 3
              ? ringStroke(count, 36)
              : { stroke: count > 2 ? 3.5 : count > 1 ? 4 : 4.5, gap: count > 2 ? 1.5 : 2 })}
            track="neutral"
            className="size-9"
          />
        ) : (
          <span aria-hidden className="size-9 shrink-0 rounded-full border border-border-soft" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {[...card.windows].reverse().map((w) => {
            const name = w.model
              ? t('common:planWindow.weeklyOf', { model: w.model })
              : t(`common:planWindow.${w.window}`)
            const short = w.model ?? t(`composer:usage.shortWindow.${w.window}`)
            return (
              <span key={w.id} className="flex min-w-0 flex-col gap-px">
                <span className="flex justify-between gap-1 text-caption leading-3.25 whitespace-nowrap">
                  <span aria-hidden className="min-w-0 truncate text-tertiary">
                    {short}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'tabular shrink-0',
                      w.level === 'ok' ? 'text-primary' : LIMIT_TEXT[w.level],
                    )}
                  >
                    {w.percent}%
                  </span>
                  <span className="sr-only">
                    {t('sidebar:account.limitUsed', { window: name, percent: w.percent })}
                  </span>
                </span>
              </span>
            )
          })}
        </span>
      </span>
      {amounts.map(({ id, amount }) => (
        <span
          key={id}
          className="-mt-px min-w-0 truncate text-badge leading-3.25 text-tertiary tabular whitespace-nowrap"
          title={amount}
        >
          {amount}
        </span>
      ))}
      {card.balances.map((balance) => (
        <span
          key={`${balance.label}/${balance.currency}`}
          className="-mt-px flex min-w-0 justify-between gap-0 text-badge leading-3.25 tracking-tight whitespace-nowrap"
        >
          <span className="min-w-0 truncate text-tertiary">
            {balance.label === 'Prepaid balance' ? t('usage:limits.prepaidBalance') : balance.label}
          </span>
          <span className="shrink-0 text-primary tabular">
            {planBalance(
              balance.amount,
              balance.currency,
              balance.currency === 'credits'
                ? t('usage:limits.units.credits')
                : balance.currency === 'requests'
                  ? t('usage:limits.units.premiumRequests')
                  : balance.currency,
            )}
          </span>
        </span>
      ))}
    </>
  )
}
