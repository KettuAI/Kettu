import { ChevronRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentAccount, ContextList, PlanLimit } from '@shared/agent-host'
import {
  knownExpiry,
  type CacheExpiry,
  type CachePhase,
  type KnownExpiry,
} from '@shared/prompt-cache'
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
import { CacheDetails } from '@renderer/features/prompt-cache/cache-details'
import { CacheHourglass } from '@renderer/features/prompt-cache/cache-hourglass'
import { useCacheLeft, useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import {
  contextRows,
  contextSegments,
  type ContextRow,
  type ContextSegment,
} from '@renderer/features/session/composer/context-bar'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { USAGE_TONE_TEXT, usageTone, type UsageTone } from '@renderer/features/sidebar/plan-usage'
import {
  countdown,
  fullTime,
  limitLabel,
  longAgo,
  money,
  resetTime,
  tokens,
} from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  loadContext,
  refreshLimits,
  useUsageStore,
  type ContextReport,
} from '@renderer/stores/usage'

/** From this share of the context the button shows the percentage, in the usage level's color. */
const CONTEXT_WARNING = 0.8

/** The context's usage level, by the same thresholds as a plan's windows. */
const contextTone = (share: number): UsageTone =>
  usageTone({ usedPercent: share * 100, state: 'ok' })

const SHORT_WINDOW = {
  five_hour: 'usage.shortWindow.five_hour',
  seven_day: 'usage.shortWindow.seven_day',
  seven_day_opus: 'usage.shortWindow.seven_day_opus',
  seven_day_sonnet: 'usage.shortWindow.seven_day_sonnet',
  monthly: 'usage.shortWindow.monthly',
  annual: 'usage.shortWindow.annual',
} as const

const isShortWindow = (name: string): name is keyof typeof SHORT_WINDOW =>
  Object.hasOwn(SHORT_WINDOW, name)

/** The limit to warn about in the control row: a reached one first, then the fullest warning. */
function warningLimit(limits: PlanLimit[]): PlanLimit | null {
  const reached = limits.find((l) => l.state === 'reached')
  if (reached) return reached
  const warnings = limits.filter((l) => l.state === 'warning')
  return warnings.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0] ?? null
}

const RING_TONE = {
  muted: ['stroke-track', 'stroke-muted-foreground'],
  success: ['stroke-track', 'stroke-muted-foreground'],
  attention: ['stroke-warning/45', 'stroke-warning'],
  destructive: ['stroke-danger/45', 'stroke-danger'],
} as const

/** The prompt cache's states the ring shows; a warm cache leaves it as it is. */
type RingCache = Exclude<CachePhase, 'warm'>

const RING_LABEL = {
  ending: { known: 'usage.cache.ringEnding', estimate: 'usage.cache.ringEndingEstimate' },
  expired: { known: 'usage.cache.ringExpired', estimate: 'usage.cache.ringExpiredEstimate' },
} as const

/** A pie inside a ring: a filling wedge, which a short arc would not be, cannot read as a spinner. */
export function Ring({
  share,
  tone,
  cache = null,
  className,
}: {
  share: number
  tone: keyof typeof RING_TONE
  /** The prompt cache in its last minutes dashes the track; once expired, the wedge fades too. */
  cache?: RingCache | null
  /** Its size: 16 px unless given. */
  className?: string
}) {
  // A circle stroked as wide as its diameter paints the wedge that its dash covers.
  const r = 2.75
  const c = 2 * Math.PI * r
  // Twelve dashes, each as long as the gap after it.
  const dash = (2 * Math.PI * 6.75) / 24
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn('size-4 shrink-0 -rotate-90', className)}>
      <circle
        cx="8"
        cy="8"
        r="6.75"
        fill="none"
        strokeWidth="1.5"
        strokeDasharray={cache ? dash : undefined}
        className={RING_TONE[tone][0]}
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
          'transition-[stroke-dashoffset,opacity] duration-(--duration-slow) ease-out-quint',
          RING_TONE[tone][1],
          cache === 'expired' && 'opacity-35',
        )}
      />
    </svg>
  )
}

export function UsageButton({
  sessionId,
  agentId,
  idle,
  running,
  usage,
  cache,
  limits,
  account,
  onCompact,
}: {
  sessionId: string
  agentId: AgentId
  /** No turn runs, so the agent can break the context down. */
  idle: boolean
  /** A turn runs, which keeps the cache in use, so the ring leaves its state out. */
  running: boolean
  usage: SessionUsage | null
  cache: CacheExpiry | null
  limits: PlanLimit[]
  account: AgentAccount | null
  onCompact: (() => void) | null
}) {
  const { t } = useTranslation('composer')
  const timed = knownExpiry(running ? null : cache)
  const phase = useCachePhase(timed)
  const ringCache = phase === 'warm' ? null : phase
  const warning = warningLimit(limits)
  if (!usage && !warning) return null
  const share = usage && usage.size > 0 ? usage.used / usage.size : 0
  const full = share >= CONTEXT_WARNING
  const tone = contextTone(share)
  const percent = Math.round(share * 100)
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
            aria-label={
              !usage
                ? t('usage.title')
                : ringCache
                  ? t(RING_LABEL[ringCache][cache?.estimate ? 'estimate' : 'known'], { percent })
                  : t('usage.contextPercent', { percent })
            }
            className="gap-1.5 px-1.5 tabular"
          />
        }
      >
        {warning && (
          <span
            key={`${warning.window}-${warning.usedPercent}`}
            className={cn(
              'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)',
              USAGE_TONE_TEXT[usageTone(warning)],
            )}
          >
            {isShortWindow(warning.window) ? t(SHORT_WINDOW[warning.window]) : limitLabel(warning)}{' '}
            {warning.usedPercent !== null && `${Math.round(warning.usedPercent)}%`}
          </span>
        )}
        {usage && full && (
          <span
            key={percent}
            className={cn(
              'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)',
              USAGE_TONE_TEXT[tone],
            )}
          >
            {percent}%
          </span>
        )}
        {usage && timed && ringCache && (
          <CacheTime key={ringCache} cache={timed} phase={ringCache} />
        )}
        {usage && <Ring share={share} tone={tone} cache={ringCache} />}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="max-h-(--available-height) w-[320px] gap-0 overflow-y-auto p-0"
      >
        {usage && (
          <ContextPart
            sessionId={sessionId}
            usage={usage}
            cache={cache}
            share={share}
            full={full}
            onCompact={onCompact}
          />
        )}
        {usage && (limits.length > 0 || account) && <Separator className="bg-border-soft" />}
        {(limits.length > 0 || account) && <PlanPart limits={limits} account={account} />}
      </PopoverContent>
    </Popover>
  )
}

function ContextPart({
  sessionId,
  usage,
  cache,
  share,
  full,
  onCompact,
}: {
  sessionId: string
  usage: SessionUsage
  cache: CacheExpiry | null
  share: number
  full: boolean
  onCompact: (() => void) | null
}) {
  const { t } = useTranslation('composer')
  const report = useUsageStore((s) => s.context[sessionId])
  const totals = usage.tokens
  const tone = contextTone(share)
  const breakdown = report?.breakdown ?? null
  const rows = breakdown ? contextRows(breakdown.categories) : null
  const busy = report?.loading === true
  const more = Boolean(totals || cache || usage.cost || onCompact)
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3 text-ui">
          <span className="font-semibold">{t('usage.context.title')}</span>
          <span className={cn('tabular text-secondary', full && USAGE_TONE_TEXT[tone])}>
            {t('usage.context.summary', {
              percent: Math.round(share * 100),
              used: tokens(usage.used),
              size: tokens(usage.size),
            })}
          </span>
        </div>
        <div
          aria-busy={busy}
          className={cn(
            'flex flex-col gap-2.5 transition-opacity duration-(--duration-fast)',
            busy && breakdown && 'opacity-60',
          )}
        >
          <ContextBar rows={rows} used={usage.used} size={usage.size} />
          {rows && <Sources rows={rows} />}
        </div>
        {!breakdown && report && <BreakdownState report={report} />}
        {breakdown && breakdown.lists.length > 0 && (
          <div className="flex flex-col">
            {breakdown.lists.map((list) => (
              <ListPart key={list.name} list={list} />
            ))}
          </div>
        )}
      </div>
      {more && <Separator className="bg-border-soft" />}
      {totals && (
        <div className="flex flex-col gap-2">
          <span className="text-ui font-semibold">{t('usage.context.session')}</span>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular">
            <Total label={t('usage.context.input')} value={totals.input} />
            <Total label={t('usage.context.output')} value={totals.output} />
            <Total label={t('usage.context.reasoning')} value={totals.thought} />
            <Total label={t('usage.context.cacheRead')} value={totals.cacheRead} />
            <Total label={t('usage.context.cacheWrite')} value={totals.cacheWrite} />
          </dl>
        </div>
      )}
      {cache && <CacheDetails cache={cache} used={usage.used} />}
      {(usage.cost || onCompact) && (
        <div className="flex min-h-6 items-center justify-between text-xs">
          <span className="text-muted-foreground tabular">
            {usage.cost && money(usage.cost.amount, usage.cost.currency)}
          </span>
          {onCompact && (
            <Button variant="outline" size="xs" onClick={onCompact}>
              {t('usage.context.compact')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function Total({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{tokens(value)}</dd>
    </div>
  )
}

const SOURCE_COLOR = [
  'bg-context-1',
  'bg-context-2',
  'bg-context-3',
  'bg-context-4',
  'bg-context-5',
  'bg-context-6',
  'bg-context-7',
] as const

/** A part's fill in the bar, and in its row's swatch (where the buffer and free space are outlined). */
const partFill = (part: ContextSegment['part']): string => {
  switch (part.kind) {
    case 'source':
      return SOURCE_COLOR[part.color - 1]!
    case 'buffer':
      return 'bg-(image:--context-hatch)'
    case 'used':
      return 'bg-text-tertiary'
    case 'free':
      return ''
  }
}

/** The context stacked by source, its autocompact buffer hatched and free space the track. */
function ContextBar({
  rows,
  used,
  size,
}: {
  rows: readonly ContextRow[] | null
  used: number
  size: number
}) {
  const { t } = useTranslation('composer')
  const segments = contextSegments(rows, used, size)
  return (
    <div
      role="img"
      aria-label={t('usage.context.used')}
      className="flex h-2 gap-px overflow-hidden rounded-full bg-track"
    >
      {segments.map((segment) => (
        <div
          key={segment.key}
          style={{ flexGrow: segment.tokens }}
          className={cn('min-w-px basis-0', partFill(segment.part))}
        />
      ))}
    </div>
  )
}

/** One row per source, then free space and the autocompact buffer. */
function Sources({ rows }: { rows: readonly ContextRow[] }) {
  return (
    <ul className="flex flex-col text-xs tabular">
      {rows.map((row) => {
        const source = row.part.kind === 'source'
        return (
          <li key={row.name} className="flex h-6 items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'size-2 shrink-0 rounded-sm',
                source ? partFill(row.part) : 'border border-border-strong',
                row.part.kind === 'buffer' && partFill(row.part),
              )}
            />
            <span className={cn('min-w-0 flex-1 truncate', !source && 'text-secondary')}>
              {row.name}
            </span>
            <span>{tokens(row.tokens)}</span>
            <span className="w-11 text-right text-tertiary">
              {row.share !== null && `${Math.round(row.share * 1000) / 10}%`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The time before the ring in the cache's last minutes, and "Expired" once it is up; the one part
 * of the button on a one-second clock.
 */
function CacheTime({ cache, phase }: { cache: KnownExpiry; phase: RingCache }) {
  const { t } = useTranslation('composer')
  const time = useCacheLeft(phase === 'ending' ? cache.expiresAt : null, countdown)
  return (
    <span
      className={cn(
        'inline-flex animate-in items-center gap-1 fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)',
        phase === 'ending' ? 'text-warning' : 'text-tertiary',
      )}
    >
      {phase === 'ending' ? (
        <>
          <CacheHourglass expiresAt={cache.expiresAt} ttl={cache.ttl} className="size-3" />
          {cache.estimate ? t('usage.cache.about', { time }) : time}
        </>
      ) : (
        t(cache.estimate ? 'usage.cache.likelyExpired' : 'usage.cache.expired')
      )}
    </span>
  )
}

/** The skeleton rows while the first breakdown is read, and the failure when it could not be. */
function BreakdownState({ report }: { report: ContextReport }) {
  const { t } = useTranslation('composer')
  if (report.loading) {
    return (
      <div aria-label={t('usage.breakdown.loading')} className="flex flex-col">
        {[4 / 5, 3 / 5, 2 / 3].map((width) => (
          <div key={width} className="flex h-6 items-center">
            <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
          </div>
        ))}
      </div>
    )
  }
  return report.error ? (
    <p className="text-xs text-muted-foreground">
      {t('usage.breakdown.error', { error: report.error })}
    </p>
  ) : null
}

function ListPart({ list }: { list: ContextList }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/list flex h-6 w-full items-center gap-2 rounded-sm text-xs outline-none focus-ring">
        <span className="flex size-2 shrink-0 justify-center">
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast) group-data-panel-open/list:rotate-90" />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{list.name}</span>
        <span className="tabular text-tertiary">{list.items.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <ul className="mb-1 grid max-h-40 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 overflow-y-auto pl-4 text-xs tabular">
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

/** The plan and its windows in the popover: the label with its tier, then a bar for each window. */
function PlanPart({ limits, account }: { limits: PlanLimit[]; account: AgentAccount | null }) {
  const { t } = useTranslation('composer')
  const now = useNow()
  const observed = limits.reduce((at, l) => Math.max(at, l.observedAt), 0)
  const plan = account?.label ?? t('usage.limits.plan')
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex items-baseline justify-between gap-3 text-ui">
        <span className="min-w-0 truncate font-semibold text-secondary">
          {account?.tier ? t('usage.limits.tier', { plan, tier: account.tier }) : plan}
        </span>
        {observed > 0 && (
          <span className="shrink-0 text-xs text-tertiary">
            {t('usage.limits.updated', { ago: longAgo(observed, now) })}
          </span>
        )}
      </div>
      {limits.length > 0 && (
        <ul className="flex flex-col gap-3">
          {limits.map((limit) => {
            const tone = usageTone(limit)
            return (
              <li key={limit.window} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2 text-xs tabular">
                  <span>{limitLabel(limit)}</span>
                  {limit.resetsAt ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={<span className="min-w-0 flex-1 truncate text-tertiary" />}
                      >
                        {resetTime(limit.resetsAt, now)}
                      </TooltipTrigger>
                      <TooltipContent>
                        {t('usage.limits.resets', { time: fullTime(limit.resetsAt) })}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <span className={tone === 'success' ? 'text-secondary' : USAGE_TONE_TEXT[tone]}>
                    {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
                  </span>
                </div>
                <Progress
                  value={limit.usedPercent ?? 0}
                  tone={tone}
                  aria-label={t('usage.limits.used', { limit: limitLabel(limit) })}
                  className="[&_[data-slot=progress-track]]:h-1.5"
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function LimitsPart({
  limits,
  account,
  agent,
  heading = true,
  titled = true,
}: {
  limits: PlanLimit[]
  account: AgentAccount | null
  /** Names whose limits these are, where nothing around the popover does. */
  agent?: { id: AgentId; name: string }
  /** The plan and the title above the windows, left out where the plan shows already. */
  heading?: boolean
  /** The "Plan limits" title at the heading's end, left out where a card above says it. */
  titled?: boolean
}) {
  const { t } = useTranslation('composer')
  const now = useNow()
  const observed = limits.reduce((at, l) => Math.max(at, l.observedAt), 0)
  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3 pb-3">
      {heading && (
        <div className="flex items-baseline justify-between text-ui">
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            {agent && (
              <>
                <AgentMark agent={agent.id} size={13} />
                <span>{agent.name}</span>
                <span className="text-muted-foreground">·</span>
              </>
            )}
            <span className="truncate">{account?.label ?? t('usage.limits.plan')}</span>
          </span>
          {titled && limits.length > 0 && (
            <span className="text-xs text-muted-foreground">{t('usage.limits.title')}</span>
          )}
        </div>
      )}
      {limits.length > 0 && (
        <ul className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-2.5 gap-y-1.5 text-xs tabular">
          {limits.map((limit) => (
            <li key={limit.window} className="contents">
              <span className="text-muted-foreground">{limitLabel(limit)}</span>
              <Progress
                value={limit.usedPercent ?? 0}
                tone={usageTone(limit)}
                aria-label={t('usage.limits.used', { limit: limitLabel(limit) })}
              />
              <span className={cn('w-8 text-right', USAGE_TONE_TEXT[usageTone(limit)])}>
                {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
              </span>
              {limit.resetsAt ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="text-right whitespace-nowrap text-muted-foreground" />}
                  >
                    {resetTime(limit.resetsAt, now)}
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('usage.limits.resets', { time: fullTime(limit.resetsAt) })}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
      {observed > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('usage.limits.updated', { ago: longAgo(observed, now) })}
        </p>
      )}
    </div>
  )
}
