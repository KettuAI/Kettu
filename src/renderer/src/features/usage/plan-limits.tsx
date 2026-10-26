import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Progress } from '@renderer/components/ui/progress'
import { countdown, USAGE_TONE_TEXT, usageTone } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { isInstalled, useAgentsStore } from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { planAgents, resetForm } from './model'
import { Panel, PanelHead } from './panel'

/**
 * Each agent's plan and its limits as they stand: the agents with limits, and the other agents
 * with usage, which say why they have none.
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
  return (
    <Panel>
      <PanelHead
        title={t('limits.title')}
        aside={
          read > 0 && (
            <span className="text-xs text-tertiary">
              {t('limits.read', { ago: longAgo(read, now) })}
            </span>
          )
        }
      />
      {agents.length === 0 ? (
        <p className="text-xs text-secondary">{t('limits.none')}</p>
      ) : (
        agents.map((status) => <Plan key={status.id} status={status} now={now} />)
      )}
    </Panel>
  )
}

function Plan({ status, now }: { status: AgentStatus; now: number }) {
  const { t } = useTranslation('usage')
  return (
    <section
      aria-label={status.name}
      className="flex flex-col gap-2 [&+&]:mt-3.5 [&+&]:pt-3.5 [&+&]:shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]"
    >
      <div className="flex items-center gap-1.75 text-ui">
        <AgentMark agent={status.id} mono={!isInstalled(status)} />
        <span className="truncate font-medium">{status.name}</span>
        {status.account && (
          <span className="ml-auto truncate text-xs text-tertiary">{status.account.label}</span>
        )}
      </div>
      {status.limits.length > 0 ? (
        status.limits.map((limit) => <Window key={limit.window} limit={limit} now={now} />)
      ) : (
        <p className="text-xs text-tertiary">
          {status.capabilities.reports
            ? t('limits.notYet')
            : t('limits.notReported', { name: status.name })}
        </p>
      )}
    </section>
  )
}

/** A limit's window: its name and how much of it is used, the bar, and when it resets. */
function Window({ limit, now }: { limit: PlanLimit; now: number }) {
  const { t } = useTranslation('usage')
  const tone = usageTone(limit)
  const name = limitLabel(limit)
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2 text-command text-secondary">
        <span className="truncate">{name}</span>
        <span className="flex-1" />
        <span
          className={cn(
            'text-xs tabular-nums',
            tone === 'success' ? 'text-secondary' : `${USAGE_TONE_TEXT[tone]} font-semibold`,
          )}
        >
          {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
        </span>
      </div>
      <Progress
        value={limit.usedPercent ?? 0}
        tone={tone}
        aria-label={t('limits.used', { limit: name })}
        className={cn(
          'mt-1.25 mb-1',
          tone === 'success' && '[&_[data-slot=progress-indicator]]:text-secondary',
        )}
      />
      {limit.resetsAt !== null && (
        <p className="text-xs text-tertiary">
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
