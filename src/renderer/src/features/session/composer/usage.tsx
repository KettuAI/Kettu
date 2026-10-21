import { ChevronRightIcon } from 'lucide-react'
import type { AgentAccount, ContextList, PlanLimit } from '@shared/agent-host'
import type { AgentId, SessionUsage } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Progress } from '@renderer/components/ui/progress'
import { Separator } from '@renderer/components/ui/separator'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { fullTime, longAgo, money, resetTime, tokens } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  loadContext,
  refreshLimits,
  useUsageStore,
  type ContextReport,
} from '@renderer/stores/usage'

/** From this share of the context the ring turns to --attention and shows the percentage. */
const CONTEXT_WARNING = 0.8

const SHORT_WINDOW: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
}

/** The limit to warn about in the control row: a reached one first, then the fullest warning. */
function warningLimit(limits: PlanLimit[]): PlanLimit | null {
  const reached = limits.find((l) => l.state === 'reached')
  if (reached) return reached
  const warnings = limits.filter((l) => l.state === 'warning')
  return warnings.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0] ?? null
}

/** A pie inside a ring: a filling wedge, which a short arc would not be, cannot read as a spinner. */
function Ring({ share, tone }: { share: number; tone: 'muted' | 'attention' }) {
  // A circle stroked as wide as its diameter paints the wedge that its dash covers.
  const r = 2.75
  const c = 2 * Math.PI * r
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 -rotate-90">
      <circle
        cx="8"
        cy="8"
        r="6.75"
        fill="none"
        strokeWidth="1.5"
        className={tone === 'attention' ? 'stroke-attention/45' : 'stroke-track'}
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth={r * 2}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, share)))}
        className={cn(
          'transition-[stroke-dashoffset] duration-(--duration-slow) ease-out-quint',
          tone === 'attention' ? 'stroke-attention' : 'stroke-muted-foreground',
        )}
      />
    </svg>
  )
}

export function UsageButton({
  sessionId,
  agentId,
  idle,
  usage,
  limits,
  account,
  onCompact,
}: {
  sessionId: string
  agentId: AgentId
  /** No turn runs, so the agent can break the context down. */
  idle: boolean
  usage: SessionUsage | null
  limits: PlanLimit[]
  account: AgentAccount | null
  onCompact: (() => void) | null
}) {
  const warning = warningLimit(limits)
  if (!usage && !warning) return null
  const share = usage && usage.size > 0 ? usage.used / usage.size : 0
  const full = share >= CONTEXT_WARNING
  const onOpenChange = (open: boolean) => {
    if (!open) return
    refreshLimits(agentId).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
    if (idle && usage) loadContext(sessionId, `${usage.used}/${usage.size}`)
  }
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="quiet"
            size="compact"
            aria-label={usage ? `Context ${Math.round(share * 100)}% used` : 'Usage'}
            className="gap-1.5 px-1.5 tabular"
          />
        }
      >
        {warning && (
          <span
            key={`${warning.window}-${warning.usedPercent}`}
            className={cn(
              'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)',
              warning.state === 'reached' ? 'text-destructive' : 'text-attention-text',
            )}
          >
            {SHORT_WINDOW[warning.window] ?? warning.label}{' '}
            {warning.usedPercent !== null && `${Math.round(warning.usedPercent)}%`}
          </span>
        )}
        {usage && full && (
          <span
            key={Math.round(share * 100)}
            className="animate-in text-attention-text fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)"
          >
            {Math.round(share * 100)}%
          </span>
        )}
        {usage && <Ring share={share} tone={full ? 'attention' : 'muted'} />}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-[320px] gap-0 p-0">
        {usage && (
          <ContextPart
            sessionId={sessionId}
            usage={usage}
            share={share}
            full={full}
            onCompact={onCompact}
          />
        )}
        {usage && (limits.length > 0 || account) && <Separator className="bg-border-soft" />}
        {(limits.length > 0 || account) && <LimitsPart limits={limits} account={account} />}
      </PopoverContent>
    </Popover>
  )
}

function ContextPart({
  sessionId,
  usage,
  share,
  full,
  onCompact,
}: {
  sessionId: string
  usage: SessionUsage
  share: number
  full: boolean
  onCompact: (() => void) | null
}) {
  const report = useUsageStore((s) => s.context[sessionId])
  const totals = usage.tokens
  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">Context</span>
        <span className={cn('tabular', full && 'text-attention-text')}>
          {Math.round(share * 100)}%
        </span>
      </div>
      <Progress
        value={Math.min(100, share * 100)}
        tone={full ? 'attention' : 'default'}
        aria-label="Context used"
      />
      <p className="text-xs text-muted-foreground tabular">
        {tokens(usage.used)} of {tokens(usage.size)} tokens ·{' '}
        {tokens(Math.max(0, usage.size - usage.used))} left
      </p>
      {report && <Breakdown report={report} />}
      {totals && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs tabular">
          <dt className="text-muted-foreground">This session</dt>
          <dd className="flex flex-wrap gap-x-3">
            <span>
              <span className="text-muted-foreground">Input</span> {tokens(totals.input)}
            </span>
            <span>
              <span className="text-muted-foreground">Output</span> {tokens(totals.output)}
            </span>
            {totals.thought !== null && (
              <span>
                <span className="text-muted-foreground">Reasoning</span> {tokens(totals.thought)}
              </span>
            )}
          </dd>
          {(totals.cacheRead !== null || totals.cacheWrite !== null) && (
            <>
              <dt />
              <dd className="flex flex-wrap gap-x-3">
                {totals.cacheRead !== null && (
                  <span>
                    <span className="text-muted-foreground">Cache read</span>{' '}
                    {tokens(totals.cacheRead)}
                  </span>
                )}
                {totals.cacheWrite !== null && (
                  <span>
                    <span className="text-muted-foreground">write</span> {tokens(totals.cacheWrite)}
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
      )}
      {(usage.cost || onCompact) && (
        <div className="flex min-h-6 items-center justify-between text-xs">
          <span className="text-muted-foreground tabular">
            {usage.cost && money(usage.cost.amount, usage.cost.currency)}
          </span>
          {onCompact && (
            <Button variant="outline" size="xs" onClick={onCompact}>
              Compact
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** What fills the context, by source, as the agent's own report gives it. */
function Breakdown({ report }: { report: ContextReport }) {
  const { breakdown, loading, error } = report
  if (!breakdown) {
    if (loading) {
      return (
        <div aria-label="Reading what fills the context" className="flex flex-col gap-1.5 py-0.5">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      )
    }
    return error ? (
      <p className="text-xs text-muted-foreground">Couldn't break the context down: {error}</p>
    ) : null
  }
  return (
    <div
      aria-busy={loading}
      className={cn(
        'flex flex-col gap-1.5 transition-opacity duration-(--duration-fast)',
        loading && 'opacity-60',
      )}
    >
      <ul className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-xs tabular">
        {breakdown.categories.map((category) => (
          <li key={category.name} className="contents">
            <span className="truncate text-muted-foreground">{category.name}</span>
            <span className="text-right">{tokens(category.tokens)}</span>
            <span className="w-10 text-right text-muted-foreground">
              {category.share !== null && `${Math.round(category.share * 1000) / 10}%`}
            </span>
          </li>
        ))}
      </ul>
      {breakdown.lists.map((list) => (
        <ListPart key={list.name} list={list} />
      ))}
    </div>
  )
}

function ListPart({ list }: { list: ContextList }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/list flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform duration-(--duration-fast) group-data-panel-open/list:rotate-90" />
        {list.name}
        <span className="tabular">{list.items.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <ul className="mt-1 grid max-h-40 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 overflow-y-auto pl-4 text-xs tabular">
          {list.items.map((item, index) => (
            <li key={index} className="contents">
              <span className="truncate" title={item.detail ?? item.name}>
                {item.name}
                {item.detail && <span className="text-muted-foreground"> · {item.detail}</span>}
              </span>
              <span className="text-right text-muted-foreground">{item.tokens}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function LimitsPart({
  limits,
  account,
  agent,
}: {
  limits: PlanLimit[]
  account: AgentAccount | null
  /** Names whose limits these are, where nothing around the popover does. */
  agent?: { id: AgentId; name: string }
}) {
  const now = useNow()
  const observed = limits.reduce((at, l) => Math.max(at, l.observedAt), 0)
  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          {agent && (
            <>
              <AgentMark agent={agent.id} size={13} />
              <span>{agent.name}</span>
              <span className="text-muted-foreground">·</span>
            </>
          )}
          <span className="truncate">{account?.label ?? 'Plan'}</span>
        </span>
        {limits.length > 0 && <span className="text-xs text-muted-foreground">Plan limits</span>}
      </div>
      {limits.length > 0 && (
        <ul className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2.5 gap-y-1.5 text-xs tabular">
          {limits.map((limit) => (
            <li key={limit.window} className="contents">
              <span className="text-muted-foreground">{limit.label}</span>
              <Progress
                value={limit.usedPercent ?? 0}
                tone={
                  limit.state === 'reached'
                    ? 'destructive'
                    : limit.state === 'warning'
                      ? 'attention'
                      : 'default'
                }
                aria-label={`${limit.label} used`}
              />
              <span
                className={cn(
                  'w-8 text-right',
                  limit.state === 'warning' && 'text-attention-text',
                  limit.state === 'reached' && 'text-destructive',
                )}
              >
                {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
              </span>
              {limit.resetsAt ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="text-right whitespace-nowrap text-muted-foreground" />}
                  >
                    {resetTime(limit.resetsAt, now)}
                  </TooltipTrigger>
                  <TooltipContent>Resets {fullTime(limit.resetsAt)}</TooltipContent>
                </Tooltip>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
      {observed > 0 && (
        <p className="text-xs text-muted-foreground">Updated {longAgo(observed, now)}</p>
      )}
    </div>
  )
}
