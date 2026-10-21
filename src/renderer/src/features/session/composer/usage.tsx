import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { SessionUsage } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Progress } from '@renderer/components/ui/progress'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { fullTime, longAgo, money, resetTime, tokens } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'

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
  usage,
  limits,
  account,
  onCompact,
}: {
  usage: SessionUsage | null
  limits: PlanLimit[]
  account: AgentAccount | null
  onCompact: (() => void) | null
}) {
  const warning = warningLimit(limits)
  if (!usage && !warning) return null
  const share = usage && usage.size > 0 ? usage.used / usage.size : 0
  const full = share >= CONTEXT_WARNING
  return (
    <Popover>
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
        {usage && <ContextPart usage={usage} share={share} full={full} onCompact={onCompact} />}
        {usage && (limits.length > 0 || account) && <Separator className="bg-border-soft" />}
        {(limits.length > 0 || account) && <LimitsPart limits={limits} account={account} />}
      </PopoverContent>
    </Popover>
  )
}

function ContextPart({
  usage,
  share,
  full,
  onCompact,
}: {
  usage: SessionUsage
  share: number
  full: boolean
  onCompact: (() => void) | null
}) {
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

export function LimitsPart({
  limits,
  account,
}: {
  limits: PlanLimit[]
  account: AgentAccount | null
}) {
  const now = useNow()
  const observed = limits.reduce((at, l) => Math.max(at, l.observedAt), 0)
  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">{account?.label ?? 'Plan'}</span>
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
