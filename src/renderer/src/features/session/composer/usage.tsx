import { useEffect } from 'react'
import { ChevronRightIcon, TimerIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentAccount, ContextList, PlanLimit } from '@shared/agent-host'
import { CONTEXT_REFRESH_MS, type ContextReport } from '@shared/context'
import {
  knownExpiry,
  type CacheExpiry,
  type CachePhase,
  type KnownExpiry,
} from '@shared/prompt-cache'
import type { AgentId, SessionUsage } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useCacheLeft, useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import {
  breakdownView,
  contextSegments,
  partFill,
  shownUsage,
  type ContextRow,
} from '@renderer/features/session/composer/context-bar'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { USAGE_TONE_TEXT, usageTone, type UsageTone } from '@renderer/features/sidebar/plan-usage'
import {
  clockTime,
  countdown,
  fullTime,
  limitLabel,
  money,
  resetTime,
  tokens,
} from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { LIMIT_TEXT, limitLevel } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { loadContext, refreshLimits, useUsageStore } from '@renderer/stores/usage'
import { useAboveBox } from './above-box'
import { ROW_BUTTON } from './menu-parts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The context's usage level, which colors its ring: see usageTone for the four. */
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
  // A plan limit's pie, in the color of its level (lib/plan-limit.ts).
  'limit-ok': 'text-limit-ok',
  'limit-warn': 'text-limit-warn',
  'limit-bad': 'text-limit-bad',
  muted: 'text-muted-foreground',
  low: 'text-usage-green',
  medium: 'text-usage-blue',
  high: 'text-usage-orange',
  critical: 'text-usage-red',
} as const

/**
 * A pie on a disc tinted in its color: a filling wedge, which a short arc would not be, cannot
 * read as a spinner, and the disc shows how much is left.
 */
export function Ring({
  share,
  tone,
  className,
}: {
  share: number
  tone: keyof typeof RING_TONE
  /** Its size: 16 px unless given. */
  className?: string
}) {
  // A circle stroked as wide as its diameter paints the wedge that its dash covers.
  const r = 3.75
  const c = 2 * Math.PI * r
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn('size-4 shrink-0 -rotate-90', RING_TONE[tone], className)}
    >
      <circle cx="8" cy="8" r="7.5" className="fill-current opacity-(--ring-tint)" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth={r * 2}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, share)))}
        className="stroke-current transition-[stroke-dashoffset] duration-(--duration-slow) ease-out-quint"
      />
    </svg>
  )
}

/** An arc over a track, filled to `share`: the cache popover's 40 px ring. */
function Arc({
  share,
  size,
  stroke,
  className,
}: {
  share: number
  size: number
  stroke: number
  /** The arc's color, as a stroke class. */
  className?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, share)))}
        className={cn(
          'transition-[stroke-dashoffset] duration-(--duration-slow) ease-out-quint',
          className ?? 'stroke-current',
        )}
      />
    </svg>
  )
}

/**
 * The prompt cache's time left, for a harness that says when its cache expires; amber in the last
 * minute. It opens what the cache saves and when it last wrote.
 */
export function CacheButton({
  cache,
  running,
  used,
}: {
  cache: CacheExpiry | null
  /** A turn runs, which keeps the cache in use, so the time is not a warning yet. */
  running: boolean
  /** The context the next message reads again once the cache has expired. */
  used: number
}) {
  const { t } = useTranslation('composer')
  const timed = knownExpiry(cache)
  const phase = useCachePhase(timed)
  const time = useCacheLeft(timed?.expiresAt ?? null, countdown)
  const [setAnchor, aboveBox] = useAboveBox()
  if (!timed || !phase) return null
  const expired = phase === 'expired'
  const label = expired
    ? t(timed.estimate ? 'usage.cache.likelyExpired' : 'usage.cache.expired')
    : timed.estimate
      ? t('usage.cache.about', { time })
      : time
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            ref={setAnchor}
            variant="quiet"
            size="sm"
            aria-label={t('usage.cache.button', { time: label })}
            className={cn(
              ROW_BUTTON,
              'text-hint tabular',
              phase === 'ending' && !running && 'text-warning aria-expanded:text-warning',
            )}
          />
        }
      >
        <TimerIcon strokeWidth={1.4} />
        {label}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={aboveBox}
        className="w-72.5 gap-0 px-4 py-3.5"
      >
        <CachePart cache={timed} phase={phase} used={used} />
      </PopoverContent>
    </Popover>
  )
}

/** What the cache saves, how long is left of it and when the last reply wrote it. */
function CachePart({
  cache,
  phase,
  used,
}: {
  cache: KnownExpiry
  phase: CachePhase
  used: number
}) {
  const { t } = useTranslation('composer')
  const left = useCacheLeft(cache.expiresAt, (ms) => ms) ?? 0
  const expired = phase === 'expired'
  const read = tokens(used)
  const hours = cache.ttl % HOUR === 0
  const count = hours ? cache.ttl / HOUR : Math.round(cache.ttl / MINUTE)
  return (
    <div className="flex flex-col text-hint">
      <div className="flex items-center gap-3">
        <Arc share={left / cache.ttl} size={40} stroke={4} className="stroke-warning" />
        <div className="min-w-0">
          <div className="text-ui font-semibold text-primary">{t('usage.cache.title')}</div>
          <div className="text-tertiary tabular">
            {expired
              ? t(cache.estimate ? 'usage.cache.likelyExpired' : 'usage.cache.expired')
              : t(cache.estimate ? 'usage.cache.leftAbout' : 'usage.cache.leftCached', {
                  time: countdown(left),
                  tokens: read,
                })}
          </div>
        </div>
      </div>
      <p className="mt-3 text-secondary">
        {expired
          ? t(cache.estimate ? 'usage.cache.ifExpired' : 'usage.cache.costExpired', {
              tokens: read,
            })
          : t('usage.cache.explain')}
      </p>
      <div className="mt-2.5 flex gap-3 text-tertiary tabular">
        <span>{t('usage.cache.lastReply', { time: clockTime(cache.lastRequestAt) })}</span>
        <span>
          {t(
            cache.estimate
              ? hours
                ? 'usage.cache.estimateLastsHours'
                : 'usage.cache.estimateLastsMinutes'
              : hours
                ? 'usage.cache.lastsHoursShort'
                : 'usage.cache.lastsMinutesShort',
            { count },
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * How much of the context is used, as a pie and its percentage, and a plan limit nearing its end
 * before them. It opens what fills the context, the session's tokens and the plan's limits.
 */
export function ContextButton({
  sessionId,
  agentId,
  idle,
  reports,
  direct,
  live,
  usage,
  context,
  limits,
  account,
}: {
  sessionId: string
  agentId: AgentId
  /** No turn runs. */
  idle: boolean
  /** Whether the agent breaks its context down at all. */
  reports: boolean
  /** Whether the agent reads its context through its connection, without a fork. */
  direct: boolean
  /** Whether a running turn's context can be read through the agent's connection. */
  live: boolean
  usage: SessionUsage | null
  context?: ContextReport
  limits: PlanLimit[]
  account: AgentAccount | null
}) {
  const { t } = useTranslation('composer')
  const warning = warningLimit(limits)
  // An account of another kind has no plan; an unknown one shows the limits the agent reports.
  const subscribed = account ? account.kind === 'account' : limits.length > 0
  const [setAnchor, aboveBox] = useAboveBox()
  const cached = useUsageStore((s) => s.context[sessionId])
  const read = context ?? cached
  const shown = shownUsage(usage, read?.breakdown ?? null)
  // Older hosts answer on demand; current hosts push every direct snapshot with the session.
  const key = usage && usage.size > 0 ? `${usage.used}/${usage.size}` : null
  const waiting = !!key && (!read || (!read.loading && read.key !== key))
  const readNow = direct && !context && key !== null && !read?.error && waiting
  useEffect(() => {
    if (readNow && key) loadContext(sessionId, key)
  }, [readNow, sessionId, key])
  if (!usage && !warning) return null
  const share = shown && shown.size > 0 ? shown.used / shown.size : 0
  const tone = contextTone(share)
  // From 80% the percentage takes the level's text color.
  const full = tone === 'high' || tone === 'critical'
  const percent = Math.round(share * 100)
  const onOpenChange = (open: boolean) => {
    if (!open) return
    refreshLimits(agentId).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
    const stale =
      !context?.breakdown ||
      context.error ||
      Date.now() - context.breakdown.observedAt >= CONTEXT_REFRESH_MS
    if (reports && (idle || live) && usage && (!context || (!context.loading && stale))) {
      loadContext(sessionId, `${usage.used}/${usage.size}`, direct)
    }
  }
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            ref={setAnchor}
            variant="quiet"
            size="sm"
            aria-label={
              usage
                ? t(read?.error ? 'usage.contextPercentStale' : 'usage.contextPercent', { percent })
                : t('usage.title')
            }
            title={read?.error ? t('usage.breakdown.refreshFailed') : undefined}
            className={cn(ROW_BUTTON, 'text-hint tabular')}
          />
        }
      >
        {warning && (
          <span
            key={`${warning.window}-${warning.usedPercent}`}
            className={cn(
              'animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-base)',
              LIMIT_TEXT[limitLevel(warning)],
            )}
          >
            {isShortWindow(warning.window) ? t(SHORT_WINDOW[warning.window]) : limitLabel(warning)}{' '}
            {warning.usedPercent !== null && `${Math.round(warning.usedPercent)}%`}
          </span>
        )}
        {usage && (
          <span className={cn('flex items-center gap-1.5', full && USAGE_TONE_TEXT[tone])}>
            <Ring share={share} tone={tone} />
            {read?.error && '≈'}
            {percent}%
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={aboveBox}
        className="max-h-(--available-height) w-85 gap-0 overflow-y-auto px-4 py-3.5"
      >
        {shown && (
          <ContextPart
            sessionId={sessionId}
            usage={shown}
            share={share}
            full={full}
            idle={idle}
            reports={reports}
            live={live}
            report={read}
            managed={context !== undefined && direct}
          />
        )}
        {subscribed && (
          <>
            {usage && <Rule />}
            <PlanPart limits={limits} account={account} />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A line across the whole popover, through its padding. */
function Rule() {
  return <div className="-mx-4 my-3 hairline-x shrink-0 bg-border-soft" />
}

function ContextPart({
  sessionId,
  usage,
  share,
  full,
  idle,
  reports,
  live,
  report,
  managed,
}: {
  sessionId: string
  usage: SessionUsage
  share: number
  full: boolean
  idle: boolean
  reports: boolean
  live: boolean
  report: ContextReport | undefined
  managed: boolean
}) {
  const { t } = useTranslation('composer')
  const totals = usage.tokens
  const tone = contextTone(share)
  const key = `${usage.used}/${usage.size}`
  const view = breakdownView(report, key, { reports, idle, live })
  // Managed reports are refreshed by the host, independently of this popover's lifetime.
  const waiting = !report || (!report.loading && report.key !== key)
  const readNow = reports && !managed && (idle || live) && waiting
  useEffect(() => {
    if (readNow) loadContext(sessionId, key)
  }, [readNow, sessionId, key])
  const rows = view.kind === 'rows' ? view.rows : null
  const breakdown = view.kind === 'rows' ? report?.breakdown : null
  const lists = breakdown?.lists ?? []
  const busy = view.kind === 'rows' && view.dimmed
  const retry = () => loadContext(sessionId, key, true)
  return (
    <div className="flex flex-col text-hint">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-ui font-semibold text-primary">
          <span className={cn(full && USAGE_TONE_TEXT[tone])}>{Math.round(share * 100)}%</span>{' '}
          <span className="font-normal text-secondary">{t('usage.context.ofUsed')}</span>
        </span>
        <span className="text-tertiary tabular">
          {tokens(usage.used)} / {tokens(usage.size)}
        </span>
      </div>
      <div
        aria-busy={busy}
        className={cn(
          'flex flex-col transition-opacity duration-(--duration-fast)',
          busy && 'opacity-60',
        )}
      >
        <ContextBar rows={rows} used={usage.used} size={usage.size} />
        {rows && <Sources rows={rows} lists={lists} />}
      </div>
      {view.kind === 'rows' && view.stale && (
        <p className="text-small text-tertiary">
          {t(
            report?.error
              ? 'usage.breakdown.refreshFailed'
              : live || idle
                ? 'usage.breakdown.updating'
                : 'usage.breakdown.stale',
          )}
        </p>
      )}
      {view.kind === 'loading' && <BreakdownRows />}
      {view.kind === 'error' && <BreakdownError error={view.error} onRetry={retry} />}
      {view.kind === 'betweenTurns' && (
        <p className="text-small text-tertiary">{t('usage.breakdown.betweenTurns')}</p>
      )}
      {lists.length > 0 && (
        <div className="mt-1.5 flex flex-col pt-1.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          {lists.map((list) => (
            <ListPart key={list.name} list={list} />
          ))}
        </div>
      )}
      {(totals || usage.cost) && (
        <>
          <Rule />
          <SessionLine usage={usage} />
        </>
      )}
    </div>
  )
}

/** The session's tokens and cost on one line, with the kinds of tokens in its tooltip. */
function SessionLine({ usage }: { usage: SessionUsage }) {
  const { t } = useTranslation('composer')
  const totals = usage.tokens
  const parts = [
    totals && t('usage.context.tokens', { tokens: tokens(totals.total) }),
    usage.cost && `≈ ${money(usage.cost.amount, usage.cost.currency)}`,
  ].filter(Boolean)
  const line = (
    <div className="flex gap-3 text-secondary">
      <span className="flex-1">{t('usage.context.session')}</span>
      <span className="text-primary tabular">{parts.join(' · ')}</span>
    </div>
  )
  if (!totals) return line
  return (
    <Tooltip>
      <TooltipTrigger render={line} />
      <TooltipContent side="left" className="tabular">
        <dl className="grid grid-cols-[auto_auto] gap-x-4">
          <Total label={t('usage.context.input')} value={totals.input} />
          <Total label={t('usage.context.output')} value={totals.output} />
          <Total label={t('usage.context.reasoning')} value={totals.thought} />
          <Total label={t('usage.context.cacheRead')} value={totals.cacheRead} />
          <Total label={t('usage.context.cacheWrite')} value={totals.cacheWrite} />
        </dl>
      </TooltipContent>
    </Tooltip>
  )
}

function Total({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null
  return (
    <>
      <dt className="opacity-70">{label}</dt>
      <dd className="text-right">{tokens(value)}</dd>
    </>
  )
}

/** The context stacked by source with 2 px between, its autocompact buffer hatched, then the track. */
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
      className="mt-2.5 mb-3 flex h-1.5 gap-0.5 overflow-hidden rounded-[3px] bg-border-soft"
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

/** One row per source, then the autocompact buffer and free space; a listed kind is underlined. */
function Sources({ rows, lists }: { rows: readonly ContextRow[]; lists: readonly ContextList[] }) {
  return (
    <ul className="flex flex-col tabular">
      {rows.map((row) => {
        const source = row.part.kind === 'source'
        const listed = lists.some((list) => list.name.toLowerCase() === row.name.toLowerCase())
        return (
          <li
            key={row.name}
            className="grid h-6 grid-cols-[10px_minmax(0,1fr)_48px_42px] items-center gap-x-2.25"
          >
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-xs',
                source ? partFill(row.part) : 'bg-border-soft',
                !source && 'shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
                row.part.kind === 'buffer' && partFill(row.part),
              )}
            />
            <span className={cn('truncate', source ? 'text-secondary' : 'text-tertiary')}>
              <span
                className={cn(
                  listed &&
                    'underline decoration-border-strong decoration-dotted underline-offset-3',
                )}
              >
                {row.name}
              </span>
            </span>
            <span className="text-right text-secondary">{tokens(row.tokens)}</span>
            <span className={cn('text-right', source ? 'text-primary' : 'text-tertiary')}>
              {row.share !== null && `${Math.round(row.share * 1000) / 10}%`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** The skeleton rows while no breakdown is here, and the failure with its Retry at the end. */
function BreakdownRows() {
  const { t } = useTranslation('composer')
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

function BreakdownError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation(['composer', 'common'])
  return (
    <div className="flex items-start gap-2 text-small text-tertiary">
      <p className="min-w-0 flex-1">{t('usage.breakdown.error', { error })}</p>
      <Button variant="outline" size="xs" onClick={onRetry} className="shrink-0">
        {t('actions.retry', { ns: 'common' })}
      </Button>
    </div>
  )
}

function ListPart({ list }: { list: ContextList }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/list -mx-2 flex h-6 w-[calc(100%+1rem)] items-center gap-1.5 rounded-md px-2 text-secondary outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-visible:bg-hover focus-ring">
        <ChevronRightIcon
          strokeWidth={1.6}
          className="size-2.75 shrink-0 text-tertiary transition-transform duration-(--duration-fast) group-data-panel-open/list:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1 truncate text-left">{list.name}</span>
        <span className="text-tertiary tabular">{list.items.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <ul className="mb-1 grid max-h-40 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 overflow-y-auto pl-4.25 text-small tabular">
          {list.items.map((item, index) => (
            <li key={index} className="contents">
              <span className="truncate" title={item.detail ?? item.name}>
                {item.name}
                {item.detail && <span className="text-tertiary"> · {item.detail}</span>}
              </span>
              <span className="text-right text-tertiary">{item.tokens}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The plan and its windows: a bar for each, in the limit colors. */
export function PlanPart({
  limits,
  account,
}: {
  limits: PlanLimit[]
  account: AgentAccount | null
}) {
  const { t } = useTranslation('composer')
  const now = useNow()
  const plan = account?.label
    ? account.tier
      ? t('usage.limits.tier', { plan: account.label, tier: account.tier })
      : account.label
    : null
  return (
    <div className="flex flex-col text-hint">
      <div className="text-small font-medium text-tertiary">
        {plan ? t('usage.limits.planOf', { plan }) : t('usage.limits.plan')}
      </div>
      {limits.map((limit) => {
        const level = limitLevel(limit)
        return (
          <div key={limit.window} className="mt-2 flex flex-col gap-1.25">
            <div className="flex text-secondary tabular">
              <span className="min-w-0 flex-1 truncate">{limitLabel(limit)}</span>
              <span className="text-primary">
                {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
              </span>
              {limit.resetsAt ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="min-w-21 shrink-0 pl-3 text-right whitespace-nowrap text-tertiary" />
                    }
                  >
                    {t('usage.limits.resetsShort', { time: resetTime(limit.resetsAt, now) })}
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('usage.limits.resets', { time: fullTime(limit.resetsAt) })}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="min-w-21 shrink-0" />
              )}
            </div>
            <Progress
              value={limit.usedPercent ?? 0}
              tone={`limit-${level}`}
              aria-label={t('usage.limits.used', { limit: limitLabel(limit) })}
              className="**:data-[slot=progress-track]:bg-border-soft"
            />
          </div>
        )
      })}
    </div>
  )
}
