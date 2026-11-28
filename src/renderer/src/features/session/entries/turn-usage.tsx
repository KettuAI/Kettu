// Per-turn cost trigger in ReplyFooter and click popover showing per-model token & cache details.

import { InformationCircleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId, TurnModelUsage, TurnUsage } from '@shared/thread'
import {
  isSubscriptionAccount,
  summarizeTurnUsage,
  turnModelCacheHitRate,
  turnModelTotalTokens,
} from '@shared/turn-usage'
import { Icon } from '@renderer/components/affect/app-shell'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { exactCount, exactTurnCost, percent, tokens, turnCost } from '@renderer/lib/format'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'

function formatDisplayedCost(amount: number, estimated: boolean, exact = false): string {
  const formatted = exact ? exactTurnCost(amount) : turnCost(amount)
  return estimated ? `~${formatted}` : formatted
}

/**
 * Resolves whether a turn's cost is an API-price estimate on a subscription account.
 * Prefers the flag recorded when the turn finished, falling back to the agent's current account
 * for legacy turns hydrated from the usage database.
 */
function useTurnSubscription(
  usage: TurnUsage,
  agentId: AgentId | null,
  hostId: string | null,
): boolean {
  const inferred = useAgentsStore((state) => {
    if (usage.subscription !== undefined || !agentId) return undefined
    const status = agentsOn(state, hostId).byId[agentId]
    if (!status) return undefined
    return isSubscriptionAccount(agentId, status.account, status.limits)
  })
  return usage.subscription ?? inferred ?? false
}

/** Compact cost or token trigger beside a reply's timestamp, opening the per-model breakdown. */
export function TurnUsageTrigger({
  usage,
  agentId,
  hostId,
  open,
  onOpenChange,
}: {
  usage: TurnUsage
  agentId: AgentId | null
  hostId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('session')
  const subscription = useTurnSubscription(usage, agentId, hostId)
  const totals = summarizeTurnUsage(usage)
  if (usage.models.length === 0 || totals.totalTokens <= 0) return null

  const hasCost = usage.costUsd !== null
  const triggerText = hasCost
    ? formatDisplayedCost(usage.costUsd!, subscription)
    : t('turnUsage.tokensShort', { tokens: tokens(totals.totalTokens) })
  const triggerTitle = hasCost
    ? subscription
      ? `${formatDisplayedCost(usage.costUsd!, true, true)} · ${t('turnUsage.subscriptionNote')}`
      : formatDisplayedCost(usage.costUsd!, false, true)
    : `${exactCount(totals.totalTokens)} · ${t('turnUsage.noPrice')}`

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="ks-reply-foot__cost tabular"
            data-open={open ? '' : undefined}
            aria-label={t('turnUsage.triggerLabel', { summary: triggerText })}
            title={triggerTitle}
          >
            {triggerText}
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="ks-turn-usage-pop w-[328px] max-w-[min(360px,calc(100vw-24px))] gap-0 overflow-hidden p-0"
      >
        {open && <TurnUsageBreakdown usage={usage} subscription={subscription} />}
      </PopoverContent>
    </Popover>
  )
}

/** Per-model breakdown content, mounted lazily only while the popover is open. */
export function TurnUsageBreakdown({
  usage,
  subscription,
}: {
  usage: TurnUsage
  subscription: boolean
}) {
  const { t } = useTranslation('session')
  const totals = summarizeTurnUsage(usage)
  const hasCost = usage.costUsd !== null
  const multiModel = usage.models.length > 1

  return (
    <div className="ks-turn-usage" data-testid="turn-usage-popover">
      <div className="ks-turn-usage__head">
        <div className="ks-turn-usage__title-row">
          <span className="ks-turn-usage__title">{t('turnUsage.title')}</span>
          {multiModel && (
            <span className="ks-turn-usage__count tabular">
              {t('turnUsage.models', { count: usage.models.length })}
            </span>
          )}
          <span
            className={
              hasCost ? 'ks-turn-usage__total-cost tabular' : 'ks-turn-usage__unpriced tabular'
            }
            title={hasCost ? formatDisplayedCost(usage.costUsd!, subscription, true) : undefined}
          >
            {hasCost ? formatDisplayedCost(usage.costUsd!, subscription) : t('turnUsage.noPrice')}
          </span>
        </div>
        <div className="ks-turn-usage__summary">
          <div className="ks-turn-usage__stat">
            <span className="ks-turn-usage__stat-label">{t('turnUsage.totalTokens')}</span>
            <span
              className="ks-turn-usage__stat-value tabular"
              title={exactCount(totals.totalTokens)}
            >
              {tokens(totals.totalTokens)}
            </span>
          </div>
          <div className="ks-turn-usage__stat">
            <span className="ks-turn-usage__stat-label">{t('turnUsage.cacheHit')}</span>
            <span className="ks-turn-usage__stat-value tabular">
              {totals.cacheHitRate !== null
                ? percent(totals.cacheHitRate)
                : t('turnUsage.unavailable')}
            </span>
          </div>
        </div>
      </div>

      <div className="ks-turn-usage__models">
        {usage.models.map((model, index) => (
          <ModelBreakdownSection
            key={`${model.model || 'unknown'}-${index}`}
            model={model}
            subscription={subscription}
          />
        ))}
      </div>

      {(subscription && hasCost) || usage.partialCost || !hasCost ? (
        <div className="ks-turn-usage__foot">
          {subscription && hasCost && (
            <p className="ks-turn-usage__note" data-testid="turn-usage-subscription-note">
              <Icon icon={InformationCircleIcon} size={13} />
              <span>{t('turnUsage.subscriptionNote')}</span>
            </p>
          )}
          {usage.partialCost && (
            <p className="ks-turn-usage__note">
              <Icon icon={InformationCircleIcon} size={13} />
              <span>{t('turnUsage.partialCostNote')}</span>
            </p>
          )}
          {!hasCost && (
            <p className="ks-turn-usage__note">
              <Icon icon={InformationCircleIcon} size={13} />
              <span>{t('turnUsage.unpricedNote')}</span>
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ModelBreakdownSection({
  model,
  subscription,
}: {
  model: TurnModelUsage
  subscription: boolean
}) {
  const { t } = useTranslation('session')
  const hitRate = turnModelCacheHitRate(model)
  const total = turnModelTotalTokens(model)
  const label = model.model || t('turnUsage.unknownModel')
  const hasCost = model.costUsd !== null

  return (
    <section className="ks-turn-usage__model" data-testid="turn-usage-model">
      <div className="ks-turn-usage__model-head">
        <span
          className={model.model ? 'ks-turn-usage__model-name' : 'ks-turn-usage__model-unknown'}
          title={model.model || undefined}
        >
          {label}
        </span>
        <span
          className={
            hasCost ? 'ks-turn-usage__model-cost tabular' : 'ks-turn-usage__model-unpriced tabular'
          }
          title={
            hasCost ? formatDisplayedCost(model.costUsd!, subscription, true) : exactCount(total)
          }
        >
          {hasCost ? formatDisplayedCost(model.costUsd!, subscription) : t('turnUsage.noPrice')}
        </span>
      </div>
      <dl className="ks-turn-usage__rows tabular">
        <TokenRow label={t('turnUsage.input')} value={model.input} />
        <TokenRow label={t('turnUsage.output')} value={model.output} />
        {model.reasoning !== undefined && model.reasoning > 0 && (
          <TokenRow label={t('turnUsage.reasoning')} value={model.reasoning} />
        )}
        <TokenRow label={t('turnUsage.cacheRead')} value={model.cacheRead} />
        <TokenRow label={t('turnUsage.cacheWrite')} value={model.cacheWrite} />
        <div className="ks-turn-usage__row">
          <dt>{t('turnUsage.cacheHitRate')}</dt>
          <dd>{hitRate !== null ? percent(hitRate) : t('turnUsage.unavailable')}</dd>
        </div>
      </dl>
    </section>
  )
}

function TokenRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="ks-turn-usage__row">
      <dt>{label}</dt>
      <dd title={exactCount(value)}>{tokens(value)}</dd>
    </div>
  )
}
