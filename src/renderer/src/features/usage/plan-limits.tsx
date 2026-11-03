import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Progress } from '@renderer/components/ui/progress'
import { countdown } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { limitLevel } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { isInstalled, useAgentsStore } from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { planAgents, resetForm, splitPlans } from './model'
import { Panel, PanelTitle } from './panel'

/** A limit's bar: 6 px on the default line, its fill by `limitLevel`. */
const LIMIT_BAR =
  '[&_[data-slot=progress-indicator]]:rounded-full [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-border'

/**
 * What is left of the plans as they stand: a block per account that reports limits, its windows
 * two to a row, then one line for the agents with usage that report none.
 */
export function PlanLimits({ used }: { used: readonly AgentId[] }) {
  const { t } = useTranslation('usage')
  const now = useNow()
  const agents = useAgentsStore(
    useShallow((s) =>
      planAgents(
        s.order.map((id) => s.byId[id]).filter((a): a is AgentStatus => !!a),
        used,
      ),
    ),
  )
  // Read afresh when the page opens; the host asks each agent at most once a minute.
  useEffect(() => {
    const { byId } = useAgentsStore.getState()
    for (const agent of Object.values(byId)) {
      if (!agent || agent.state !== 'ready' || agent.limits.length === 0) continue
      refreshLimits(agent.id).catch((error: unknown) =>
        console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
      )
    }
  }, [])
  const read = Math.max(0, ...agents.flatMap((a) => a.limits.map((l) => l.observedAt)))
  const { rows, unreported } = splitPlans(agents)
  const names = new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
    unreported.map((a) => a.name),
  )
  return (
    <Panel className="pt-4 pb-3.5">
      <div className="flex items-center gap-2">
        <PanelTitle className="flex-1">{t('limits.title')}</PanelTitle>
        {read > 0 && (
          <span className="text-small leading-[normal] text-tertiary">
            {t('limits.read', { ago: longAgo(read, now) })}
          </span>
        )}
      </div>
      {agents.length === 0 ? (
        <p className="pt-3.5 pb-0.5 text-hint leading-[normal] text-tertiary">{t('limits.none')}</p>
      ) : (
        <>
          {rows.map((status, i) => (
            <Plan key={status.id} status={status} now={now} first={i === 0} />
          ))}
          {unreported.length > 0 && (
            <p
              className={
                rows.length > 0
                  ? 'pt-3 text-hint leading-[normal] text-tertiary shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]'
                  : 'pt-3.5 text-hint leading-[normal] text-tertiary'
              }
            >
              {t('limits.notReported', { name: names, count: unreported.length })}
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

/** An account's block: its mark, name and plan, then its windows. */
function Plan({ status, now, first }: { status: AgentStatus; now: number; first: boolean }) {
  const { t } = useTranslation('usage')
  return (
    <section
      aria-label={status.name}
      className={
        first
          ? 'flex flex-col gap-3 py-3.5'
          : 'flex flex-col gap-3 py-3.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]'
      }
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <AgentMark agent={status.id} size={18} mono={!isInstalled(status)} />
        <span className="truncate text-lede leading-[normal] font-medium text-primary">
          {status.name}
        </span>
        {status.account && (
          <span className="truncate text-hint leading-[normal] text-tertiary">
            {status.account.label}
          </span>
        )}
      </div>
      {status.limits.length > 0 ? (
        <div className="grid grid-cols-2 gap-6">
          {status.limits.map((limit) => (
            <Window key={limit.window} limit={limit} now={now} />
          ))}
        </div>
      ) : (
        <p className="text-hint leading-[normal] text-tertiary">{t('limits.notYet')}</p>
      )}
    </section>
  )
}

/** A limit's window: its name and how much of it is used, the bar, and when it resets. */
function Window({ limit, now }: { limit: PlanLimit; now: number }) {
  const { t } = useTranslation('usage')
  const name = limitLabel(limit)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex justify-between gap-2 text-hint leading-[normal] text-tertiary">
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-primary tabular-nums">
          {limit.usedPercent === null
            ? '—'
            : t('limits.usedShort', { percent: `${Math.round(limit.usedPercent)}%` })}
        </span>
      </div>
      <Progress
        value={limit.usedPercent ?? 0}
        tone={`limit-${limitLevel(limit)}`}
        aria-label={t('limits.used', { limit: name })}
        className={LIMIT_BAR}
      />
      {limit.resetsAt !== null && (
        <p className="text-small leading-[normal] text-tertiary">
          {resetForm(limit.resetsAt, now) === 'in'
            ? t('limits.resetsIn', { time: countdown(limit.resetsAt - now)! })
            : t('limits.resetsAt', { time: resetWhen(limit.resetsAt, now) })}
        </p>
      )}
    </div>
  )
}

/** When a window resets: its time today, its day and time within six days, its date beyond. */
function resetWhen(at: number, now: number): string {
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0)
  // Rounded, since a day across a change of the clocks is not 24 hours.
  const days = Math.round((day(at) - day(now)) / 86_400_000)
  const format: Intl.DateTimeFormatOptions =
    days < 0 || days > 6
      ? { month: 'short', day: 'numeric' }
      : { ...(days > 0 && { weekday: 'short' }), hour: 'numeric', minute: '2-digit' }
  return new Intl.DateTimeFormat(currentLocale(), format).format(at)
}
