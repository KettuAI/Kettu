import { useState } from 'react'
import { useSortable } from '@dnd-kit/react/sortable'
import { ArrowReloadHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { useHostInfo } from '@renderer/features/session/composer/host-info'
import { PlanPart } from '@renderer/features/session/composer/usage'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { ringStroke } from '@renderer/features/usage/plan-cards'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import {
  balanceLabel,
  monthDayTime,
  planAmount,
  planBalance,
  windowLabel,
  windowShort,
} from '@renderer/lib/format'
import { LIMIT_TEXT, shownPercent } from '@renderer/lib/plan-limit'
import type { CardResets } from '@renderer/lib/plan-readings'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { useHostName, useWindowHost } from '@renderer/stores/window-host'
import { hasModelGroups, joinPlanTier, type PlanCard } from './model'

/**
 * An account's plan windows: its rings and, from the outer ring in, each window's figure. It
 * opens the Usage page; hovered or focused, it shows every window beside it.
 */
export function PlanLimitCard({
  card,
  index,
  sortHint,
  dragging,
  onOpen,
}: {
  card: PlanCard
  index: number
  sortHint?: string
  dragging: boolean
  onOpen: () => void
}) {
  const hostName = useHostName()
  const { ref, isDragging } = useSortable({
    id: card.key,
    index,
    disabled: !sortHint,
    transition: prefersReducedMotion() ? null : undefined,
  })
  const [detailsOpen, setDetailsOpen] = useState(false)
  // With every host shown, which of them the account is on.
  const hosts = useWindowHost().kind === 'all' ? card.hostIds.map(hostName).join(' · ') : null
  const plan = card.account?.label ? joinPlanTier(card.account.label, card.account.tier) : null
  const hasFooter = card.balances.length > 0 || Boolean(card.resets)
  return (
    <HoverCard open={detailsOpen && !dragging} onOpenChange={setDetailsOpen}>
      <HoverCardTrigger
        delay={100}
        closeDelay={100}
        render={
          <button
            ref={ref}
            type="button"
            aria-describedby={sortHint}
            aria-keyshortcuts={sortHint && 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight'}
            data-sortable={sortHint ? '' : undefined}
            data-dragging={isDragging ? '' : undefined}
            onClick={onOpen}
            className={cn(
              'kettu-plan-card min-w-0 rounded-tile outline-none select-none',
              hasModelGroups(card) && 'col-span-2',
            )}
          />
        }
      >
        <CardFace card={card} />
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={6} className="w-77 p-3">
        <div className="mb-2.5 flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <AgentTile agent={card.agentId} hostId={card.hostId} size={18} />
              <span className="min-w-0 truncate text-small font-semibold text-primary">
                {card.agentName}
              </span>
            </span>
            {plan ? (
              <span className="kettu-ctx__tier">{plan}</span>
            ) : (
              hosts && (
                <span className="min-w-0 shrink truncate text-hint text-tertiary">{hosts}</span>
              )
            )}
          </div>
          {plan && hosts && (
            <span className="min-w-0 truncate text-hint text-tertiary">{hosts}</span>
          )}
        </div>
        <PlanPart limits={card.limits} account={card.account} showHeader={false} />
        {hasFooter && <HoverFooter balances={card.balances} resets={card.resets} />}
      </HoverCardContent>
    </HoverCard>
  )
}

function CardFace({ card }: { card: PlanCard }) {
  const { t } = useTranslation(['sidebar', 'composer', 'common', 'usage'])
  const view = useLimitView()
  const windowHost = useWindowHost()
  const hostName = useHostName()
  const hostInfo = useHostInfo(card.hostId)
  const scopedHost = windowHost.kind === 'all' && card.hostScoped ? hostName(card.hostId) : null
  const count = card.windows.length
  const groups = hasModelGroups(card)
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
      {scopedHost && (
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-badge leading-3.5 text-tertiary">
          <HostIcon platform={hostInfo.platform} className="size-2.75 shrink-0" />
          <span className="min-w-0 truncate">{scopedHost}</span>
        </span>
      )}
      <span className="mt-1.75 flex min-w-0 items-center gap-2.25">
        <span className="relative flex shrink-0">
          {count > 0 ? (
            <PlanRings
              rings={card.windows.map((w) => ({
                id: w.id,
                percent: shownPercent(w.percent, view),
                level: w.level,
              }))}
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
          {card.resets && (
            <span className="absolute -right-1.5 -bottom-1 flex h-3.5 items-center justify-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--shell-accent)_14%,var(--bg-surface))] px-1.25 text-badge leading-3.5 font-medium text-(--primary-foreground) tabular shadow-[0_0_0_1.5px_var(--bg-surface)]">
              <Icon icon={ArrowReloadHorizontalIcon} size={10} />
              <span aria-hidden>{card.resets.count}</span>
              <span className="sr-only">
                {t('usage:resets.count', { count: card.resets.count })}
              </span>
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {[...card.windows].reverse().map((w) => {
            const parts = { kind: w.window, count: null, scope: w.model }
            const name = windowLabel(parts)
            // Model groups have windows of two lengths each, so their lines name the length and
            // the group; another model's line is named for the model alone.
            const short = w.model && !groups ? w.model : windowShort(parts)
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
                    {shownPercent(w.percent, view)}%
                  </span>
                  <span className="sr-only">
                    {t(
                      view === 'left' ? 'sidebar:account.limitLeft' : 'sidebar:account.limitUsed',
                      {
                        window: name,
                        percent: shownPercent(w.percent, view),
                      },
                    )}
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
          <span className="min-w-0 truncate text-tertiary">{balanceLabel(balance.label)}</span>
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

/** 侧边栏悬浮卡底部紧凑脚注：展示积分/额度余额与重置次数，对齐 L1 精修排版。 */
function HoverFooter({
  balances,
  resets,
}: {
  balances: PlanCard['balances']
  resets: CardResets | null
}) {
  const { t } = useTranslation('usage')
  return (
    <div className="kettu-plan-hover__foot">
      {balances.map((balance) => (
        <div key={`${balance.label}/${balance.currency}`} className="kettu-plan-hover__foot-row">
          <span className="min-w-0 truncate">{balanceLabel(balance.label)}</span>
          <span className="kettu-plan-hover__foot-val tabular">
            {planBalance(
              balance.amount,
              balance.currency,
              balance.currency === 'credits'
                ? t('limits.units.credits')
                : balance.currency === 'requests'
                  ? t('limits.units.premiumRequests')
                  : balance.currency,
            )}
          </span>
        </div>
      ))}
      {resets &&
        (resets.each && resets.each.length === 1 ? (
          <div className="kettu-plan-hover__foot-row">
            <span className="min-w-0 truncate">{t('resets.count', { count: resets.count })}</span>
            <span className="kettu-plan-hover__foot-val tabular">
              {resets.each[0]!.until === null
                ? t('resets.never')
                : t('resets.until', { time: monthDayTime(resets.each[0]!.until) })}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <div className="kettu-plan-hover__foot-row">
              <span className="min-w-0 truncate">{t('resets.count', { count: resets.count })}</span>
              {!resets.each && (
                <span className="kettu-plan-hover__foot-val">{t('resets.unknown')}</span>
              )}
            </div>
            {resets.each?.map((credit) => (
              <div key={credit.id} className="truncate text-right text-secondary tabular">
                {credit.until === null
                  ? t('resets.never')
                  : t('resets.until', { time: monthDayTime(credit.until) })}
              </div>
            ))}
          </div>
        ))}
    </div>
  )
}
