import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { LimitsPart } from '@renderer/features/session/composer/usage'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { refreshLimits } from '@renderer/stores/usage'
import { countdown, tightestLimit } from './plan-usage'

/** One chip per agent that reports plan limits, each opening that agent's limits. */
export function PlanUsageStrip() {
  const agents = useAgentsStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((a): a is AgentStatus => !!a && a.limits.length > 0),
    ),
  )
  const now = useNow()
  if (!agents.length) return null
  return (
    <div
      role="group"
      aria-label="Plan usage"
      className="flex flex-wrap items-center gap-0.5 px-0.5"
    >
      {agents.map((agent) => (
        <UsageChip key={agent.id} agent={agent} now={now} />
      ))}
    </div>
  )
}

function UsageChip({ agent, now }: { agent: AgentStatus; now: number }) {
  const limit = tightestLimit(agent.limits, now)
  const percent = limit?.usedPercent == null ? null : Math.round(limit.usedPercent)
  const left = limit?.resetsAt ? countdown(limit.resetsAt - now) : null
  const label = limit
    ? `${agent.name} plan usage: ${limit.label} ${percent === null ? 'unknown' : `${percent}%`}${left ? `, resets in ${left}` : ''}`
    : `${agent.name} plan usage: not known since its windows reset`
  const onOpenChange = (open: boolean) => {
    if (!open || agent.state !== 'ready') return
    refreshLimits(agent.id).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
  }
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs tabular outline-none transition-colors duration-(--duration-fast) hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:bg-sidebar-accent"
          />
        }
      >
        <AgentMark agent={agent.id} size={13} />
        <span
          className={cn(
            limit?.state === 'warning' && 'text-attention-text',
            limit?.state === 'reached' && 'text-destructive',
            percent === null && 'text-muted-foreground',
          )}
        >
          {percent === null ? '—' : `${percent}%`}
        </span>
        {left && <span className="text-muted-foreground">{left}</span>}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-80 gap-0 p-0">
        <LimitsPart limits={agent.limits} account={agent.account} agent={agent} />
      </PopoverContent>
    </Popover>
  )
}
