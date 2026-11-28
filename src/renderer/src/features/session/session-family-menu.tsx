import { useEffect, useMemo, useState } from 'react'
import {
  AiChat02Icon,
  Alert02Icon,
  ArrowDown01Icon,
  InformationCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionUsage } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { exactCount, money, tokens } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { openSession } from '@renderer/stores/view'
import { BackgroundDots, TurnDots } from './turn-dots'
import {
  fetchFamilyUsages,
  hasKnownCost,
  hasKnownTokens,
  mergeFamilyUsageSources,
  rollupFamilyUsage,
  selectFamilyMember,
  sessionTotalInput,
  type CurrencyAmount,
  type FamilyActivity,
  type FamilyMemberStatus,
  type FamilyUsageRollup,
  type MemberUsageState,
  type SessionFamily,
  type SessionFamilyMember,
} from './session-family-model'

/** Max visual nesting depth for indentation inside the family list. */
const MAX_INDENT_DEPTH = 3

/** Formats one or more currency sums ("≈ $0.85" or "≈ $0.85 + ¥2.00"). */
function formatCostTotals(totals: readonly CurrencyAmount[]): string {
  return totals.map((item) => `\u2248 ${money(item.amount, item.currency)}`).join(' + ')
}

/** Builds a concise, accurate explanation when any family member lacks usage data or is loading. */
function rollupNotice(t: TFunction<'session'>, rollup: FamilyUsageRollup): string | null {
  if (rollup.loadingCount > 0) {
    return t('sessionFamily.usage.loading', { count: rollup.loadingCount })
  }
  const tokensMissing = rollup.tokens.missingCount
  const costMissing = rollup.cost.missingCount
  if (tokensMissing === 0 && costMissing === 0) return null

  const noTokensAtAll = rollup.tokens.knownCount === 0
  const noCostAtAll = rollup.cost.knownCount === 0
  if (noTokensAtAll && noCostAtAll) {
    if (rollup.errorCount === rollup.memberCount) {
      return t('sessionFamily.usage.loadFailed')
    }
    return t('sessionFamily.usage.allUnavailable')
  }

  if (rollup.sameMissingSet && tokensMissing > 0) {
    return t('sessionFamily.usage.missingBoth', { count: tokensMissing })
  }
  if (tokensMissing > 0 && costMissing === 0) {
    return t('sessionFamily.usage.missingTokens', { count: tokensMissing })
  }
  if (costMissing > 0 && tokensMissing === 0) {
    return t('sessionFamily.usage.missingCost', { count: costMissing })
  }
  return t('sessionFamily.usage.missingMixed', {
    tokensCount: tokensMissing,
    costCount: costMissing,
  })
}

/** Small live indicator shown on the header trigger button when any member needs attention or runs. */
function TriggerActivityDot({ activity }: { activity: FamilyActivity }) {
  if (activity.waitingCount > 0) {
    return (
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full bg-attention-dot shadow-[0_0_0_2px_var(--attention-halo)]"
      />
    )
  }
  if (activity.errorCount > 0) {
    return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />
  }
  if (activity.runningCount > 0 || activity.startingCount > 0) {
    return (
      <span aria-hidden className="grid shrink-0 place-items-center">
        <TurnDots phase="working" />
      </span>
    )
  }
  if (activity.backgroundCount > 0) {
    return (
      <span aria-hidden className="grid shrink-0 place-items-center">
        <BackgroundDots />
      </span>
    )
  }
  return null
}

/**
 * Header entry for a session family:
 * - `crumb` (when viewing a child/sub-session): replaces the parent crumb at the start of the top
 *   bar, keeping the parent icon and title with a compact count and chevron, followed by `/`.
 * - `chip` (when viewing the root/parent session with children): shows a restrained chip after the
 *   More menu so users can open the exact same navigation and family usage rollup popover.
 */
export function SessionFamilyMenu({
  family,
  variant,
}: {
  family: SessionFamily
  variant: 'crumb' | 'chip'
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)

  const parent = family.parent
  const parentTitle = parent ? sessionTitle(parent) : ''
  const triggerLabel = parent
    ? t('sessionFamily.triggerChild', { title: parentTitle, count: family.members.length })
    : t('sessionFamily.triggerParent', { count: family.childCount })

  const trigger =
    variant === 'crumb' && parent ? (
      <Button
        variant="quiet"
        size="compact"
        aria-label={triggerLabel}
        title={triggerLabel}
        data-testid="session-family-trigger"
        className="ks-crumb ks-family-trigger h-6.5 min-w-16 shrink-1000 gap-1.5 pr-1.5 pl-1.5 font-normal"
      >
        {parent.origin === 'subagent' ? (
          <Icon icon={AiChat02Icon} size={14} />
        ) : (
          <AgentMark agent={parent.agentId} size={14} hostId={hostOfSession(parent)} />
        )}
        <span className="max-w-28 truncate">{parentTitle}</span>
        <TriggerActivityDot activity={family.activity} />
        <span aria-hidden className="ks-family-trigger__count tabular">
          {family.members.length}
        </span>
        <Icon icon={ArrowDown01Icon} size={12} />
      </Button>
    ) : (
      <button
        type="button"
        aria-label={triggerLabel}
        title={triggerLabel}
        data-testid="session-family-trigger"
        className="ks-chip ks-family-chip"
      >
        <TriggerActivityDot activity={family.activity} />
        <span className="ks-chip__text">
          {t('sessionFamily.subSessionCount', { count: family.childCount })}
        </span>
        <Icon icon={ArrowDown01Icon} size={12} />
      </button>
    )

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={trigger} />
        <PopoverContent
          align="start"
          sideOffset={8}
          className="ks-family-pop w-[368px] max-w-[min(400px,calc(100vw-24px))] gap-0 overflow-hidden p-0"
        >
          {open && <SessionFamilyPopoverContent family={family} onClose={() => setOpen(false)} />}
        </PopoverContent>
      </Popover>
      {variant === 'crumb' && parent && (
        <span aria-hidden className="mx-1.5 shrink-0 text-ui text-border-strong">
          /
        </span>
      )}
    </>
  )
}

/** Mounted only while the popover is open so usage queries stay lazy and zero-cost at rest. */
export function SessionFamilyPopoverContent({
  family,
  onClose,
}: {
  family: SessionFamily
  onClose: () => void
}) {
  const { t } = useTranslation('session')
  const memberIds = useMemo(() => family.members.map((m) => m.summary.id), [family.members])
  const fetchKey = useMemo(
    () => family.members.map((m) => `${m.summary.id}:${m.summary.updatedAt}`).join('|'),
    [family.members],
  )

  // Live usages already loaded in the renderer (including the active session's streaming turns).
  const liveUsageById = useThreadsStore(
    useShallow((state) => {
      const out: Record<string, SessionUsage | null> = {}
      for (const id of memberIds) {
        const replica = state.replicas[id]
        if (replica?.status === 'ready' && replica.state) {
          out[id] = replica.state.session.usage
        }
      }
      return out
    }),
  )

  const [fetched, setFetched] = useState<{
    key: string
    byId: Record<string, MemberUsageState>
  }>({ key: '', byId: {} })

  const loading = fetched.key !== fetchKey

  useEffect(() => {
    let cancelled = false
    void fetchFamilyUsages(family.members).then((byId) => {
      if (cancelled) return
      setFetched({ key: fetchKey, byId })
    })
    return () => {
      cancelled = true
    }
  }, [family.members, fetchKey])

  const usageById = useMemo(
    () => mergeFamilyUsageSources(family.members, liveUsageById, fetched.byId, loading),
    [family.members, liveUsageById, fetched.byId, loading],
  )
  const rollup = useMemo(
    () => rollupFamilyUsage(family.members, usageById),
    [family.members, usageById],
  )
  const notice = rollupNotice(t, rollup)

  return (
    <div className="ks-family" data-testid="session-family-popover">
      <div className="ks-family__head">
        <div className="ks-family__title-row">
          <span className="ks-family__title">{t('sessionFamily.title')}</span>
          <span className="ks-family__count tabular">
            {t('sessionFamily.memberCount', { count: family.members.length })}
          </span>
          <FamilyActivitySummary activity={family.activity} />
        </div>
        <div className="ks-family__rollup" data-testid="session-family-rollup">
          <div className="ks-family__metric">
            <div className="ks-family__metric-head">
              <span className="ks-family__metric-label">
                {t('sessionFamily.usage.totalTokens')}
              </span>
              {rollup.tokens.partial && (
                <span className="ks-family__tag">{t('sessionFamily.usage.partial')}</span>
              )}
            </div>
            <div className="ks-family__metric-value tabular" data-testid="family-total-tokens">
              {rollup.loadingCount > 0 && rollup.tokens.total === null ? (
                <span className="ks-family__loading">
                  <Spinner className="size-3" />
                </span>
              ) : rollup.tokens.total !== null ? (
                tokens(rollup.tokens.total)
              ) : (
                <span className="ks-family__unavailable">
                  {t('sessionFamily.usage.unavailable')}
                </span>
              )}
            </div>
            {rollup.tokens.input !== null && rollup.tokens.output !== null && (
              <div className="ks-family__metric-sub tabular">
                {t('sessionFamily.usage.ioSummary', {
                  input: tokens(rollup.tokens.input),
                  output: tokens(rollup.tokens.output),
                })}
              </div>
            )}
          </div>
          <div className="ks-family__metric">
            <div className="ks-family__metric-head">
              <span className="ks-family__metric-label">{t('sessionFamily.usage.totalCost')}</span>
              {rollup.cost.partial && (
                <span className="ks-family__tag">{t('sessionFamily.usage.partial')}</span>
              )}
            </div>
            <div className="ks-family__metric-value tabular" data-testid="family-total-cost">
              {rollup.loadingCount > 0 && rollup.cost.totals.length === 0 ? (
                <span className="ks-family__loading">
                  <Spinner className="size-3" />
                </span>
              ) : rollup.cost.totals.length > 0 ? (
                formatCostTotals(rollup.cost.totals)
              ) : (
                <span className="ks-family__unavailable">
                  {t('sessionFamily.usage.unavailable')}
                </span>
              )}
            </div>
          </div>
        </div>
        {notice && (
          <div className="ks-family__notice" role="status" data-testid="family-usage-notice">
            <span className="mt-0.5 grid shrink-0">
              <Icon icon={rollup.errorCount > 0 ? Alert02Icon : InformationCircleIcon} size={13} />
            </span>
            <span>{notice}</span>
          </div>
        )}
      </div>
      <div
        className="ks-family__list"
        role="list"
        aria-label={t('sessionFamily.listLabel')}
        data-testid="session-family-list"
      >
        {family.members.map((member) => (
          <FamilyMemberRow
            key={member.summary.id}
            member={member}
            usageState={usageById[member.summary.id] ?? { loadState: 'ready', usage: null }}
            onSelect={() => selectFamilyMember(member, { onClose, backTo, openSession })}
          />
        ))}
      </div>
    </div>
  )
}

function FamilyActivitySummary({ activity }: { activity: FamilyActivity }) {
  const { t } = useTranslation('session')
  const parts: string[] = []
  if (activity.waitingCount > 0) {
    parts.push(t('sessionFamily.activity.waiting', { count: activity.waitingCount }))
  }
  const active = activity.runningCount + activity.startingCount
  if (active > 0) {
    parts.push(t('sessionFamily.activity.running', { count: active }))
  } else if (activity.backgroundCount > 0) {
    parts.push(t('sessionFamily.activity.background', { count: activity.backgroundCount }))
  }
  if (activity.errorCount > 0) {
    parts.push(t('sessionFamily.activity.error', { count: activity.errorCount }))
  }
  if (parts.length === 0) return null
  return (
    <span
      className={cn(
        'ks-family__activity tabular',
        activity.waitingCount > 0 && 'ks-family__activity--waiting',
        activity.waitingCount === 0 && activity.errorCount > 0 && 'ks-family__activity--error',
      )}
    >
      {parts.join(' \u00b7 ')}
    </span>
  )
}

function memberStatusLabel(t: TFunction<'session'>, status: FamilyMemberStatus): string {
  switch (status) {
    case 'waiting':
      return t('sessionFamily.status.waiting')
    case 'error':
      return t('sessionFamily.status.error')
    case 'auth':
      return t('sessionFamily.status.auth')
    case 'running':
      return t('sessionFamily.status.running')
    case 'background':
      return t('sessionFamily.status.background')
    case 'starting':
      return t('sessionFamily.status.starting')
    case 'unread':
      return t('sessionFamily.status.unread')
    case 'idle':
      return t('sessionFamily.status.idle')
  }
}

function MemberStatusMark({ status, label }: { status: FamilyMemberStatus; label: string }) {
  switch (status) {
    case 'waiting':
      return (
        <span
          role="img"
          aria-label={label}
          className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
        />
      )
    case 'error':
    case 'auth':
      return (
        <span role="img" aria-label={label} className="grid text-danger">
          <Icon icon={Alert02Icon} size={13} />
        </span>
      )
    case 'running':
      return (
        <span role="img" aria-label={label} className="grid">
          <TurnDots phase="working" />
        </span>
      )
    case 'background':
      return (
        <span role="img" aria-label={label} className="grid">
          <BackgroundDots />
        </span>
      )
    case 'starting':
      return (
        <span role="img" aria-label={label} className="grid">
          <TurnDots phase="thinking" />
        </span>
      )
    case 'unread':
      return <span role="img" aria-label={label} className="size-1.5 rounded-full bg-(--accent)" />
    case 'idle':
      return <span aria-hidden className="ks-family__idle-dot" />
  }
}

function memberUsageTooltip(
  t: TFunction<'session'>,
  usageState: MemberUsageState,
): string | undefined {
  if (usageState.loadState === 'loading') return t('sessionFamily.usage.loadingRow')
  if (usageState.loadState === 'error') return t('sessionFamily.usage.rowLoadFailed')
  const usage = usageState.usage
  const tokOk = hasKnownTokens(usage)
  const costOk = hasKnownCost(usage)
  if (!tokOk && !costOk) return t('sessionFamily.usage.rowUnavailable')

  const parts: string[] = []
  if (tokOk && usage?.tokens) {
    const input = sessionTotalInput(usage) ?? usage.tokens.input
    parts.push(
      t('sessionFamily.usage.rowTokensDetail', {
        total: exactCount(usage.tokens.total),
        input: exactCount(input),
        output: exactCount(usage.tokens.output),
      }),
    )
  } else {
    parts.push(t('sessionFamily.usage.tokensUnavailable'))
  }
  if (costOk && usage?.cost) {
    parts.push(`\u2248 ${money(usage.cost.amount, usage.cost.currency)}`)
  } else {
    parts.push(t('sessionFamily.usage.costUnavailable'))
  }
  return parts.join(' \u00b7 ')
}

function FamilyMemberRow({
  member,
  usageState,
  onSelect,
}: {
  member: SessionFamilyMember
  usageState: MemberUsageState
  onSelect: () => void
}) {
  const { t } = useTranslation('session')
  const { summary, depth, isRoot, isCurrent, status } = member
  const title = sessionTitle(summary)
  const statusText = memberStatusLabel(t, status)
  const subtitle =
    summary.origin === 'subagent'
      ? t('subagent.fallbackTitle')
      : agentName(summary.agentId, hostOfSession(summary))
  const indent = Math.min(depth, MAX_INDENT_DEPTH)

  const tokOk = usageState.loadState === 'ready' && hasKnownTokens(usageState.usage)
  const costOk = usageState.loadState === 'ready' && hasKnownCost(usageState.usage)
  const usageTitle = memberUsageTooltip(t, usageState)

  return (
    <div role="listitem">
      <button
        type="button"
        onClick={onSelect}
        aria-current={isCurrent ? 'true' : undefined}
        data-current={isCurrent ? '' : undefined}
        data-testid={`session-family-item-${summary.id}`}
        style={indent > 0 ? { paddingLeft: `${12 + indent * 14}px` } : undefined}
        className="ks-family__row"
      >
        <span className="ks-family__icon">
          {summary.origin === 'subagent' ? (
            <Icon icon={AiChat02Icon} size={14} />
          ) : (
            <AgentMark agent={summary.agentId} size={14} hostId={hostOfSession(summary)} />
          )}
        </span>
        <span className="ks-family__main">
          <span className="ks-family__row-top">
            <span className="ks-family__row-title">{title}</span>
            {isRoot && (
              <span className="ks-family__badge ks-family__badge--root">
                {t('sessionFamily.parentBadge')}
              </span>
            )}
            {isCurrent && (
              <span className="ks-family__badge ks-family__badge--current">
                <Icon icon={Tick02Icon} size={10} />
                {t('sessionFamily.currentBadge')}
              </span>
            )}
          </span>
          <span className="ks-family__row-meta">
            <span className="truncate">{subtitle}</span>
            <span aria-hidden>&middot;</span>
            <span
              className={cn(
                status === 'waiting' && 'text-attention',
                (status === 'error' || status === 'auth') && 'text-danger',
              )}
            >
              {statusText}
            </span>
          </span>
        </span>
        <span className="ks-family__usage tabular" title={usageTitle}>
          {usageState.loadState === 'loading' ? (
            <span className="ks-family__usage-missing">&hellip;</span>
          ) : usageState.loadState === 'error' ? (
            <span className="ks-family__usage-missing">
              {t('sessionFamily.usage.unavailableShort')}
            </span>
          ) : !tokOk && !costOk ? (
            <span className="ks-family__usage-missing">
              {t('sessionFamily.usage.unavailableShort')}
            </span>
          ) : (
            <>
              <span className="ks-family__usage-primary">
                {tokOk && usageState.usage?.tokens ? (
                  tokens(usageState.usage.tokens.total)
                ) : (
                  <span className="ks-family__usage-missing">
                    {t('sessionFamily.usage.noTokensShort')}
                  </span>
                )}
              </span>
              <span className="ks-family__usage-secondary">
                {costOk && usageState.usage?.cost ? (
                  `\u2248 ${money(usageState.usage.cost.amount, usageState.usage.cost.currency)}`
                ) : (
                  <span className="ks-family__usage-missing">
                    {t('sessionFamily.usage.noCostShort')}
                  </span>
                )}
              </span>
            </>
          )}
        </span>
        <span className="ks-family__status-slot">
          <MemberStatusMark status={status} label={statusText} />
        </span>
      </button>
    </div>
  )
}

export type { SessionSummary }
