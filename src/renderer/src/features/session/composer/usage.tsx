import { useEffect } from 'react'
import { ChevronRightIcon, TimerIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentAccount, ContextList, PlanLimit } from '@shared/agent-host'
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
  compactsAt,
  contextSegments,
  partFill,
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
import { openUsage } from '@renderer/stores/view'
import { ROW_BUTTON } from './menu-parts'

/** From this share of the context the percentage takes the usage level's color. */
const CONTEXT_WARNING = 0.8

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The context's usage level: plenty below 80% used, getting close from 80%, nearly full from 95%. */
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

/** A pie inside a ring: a filling wedge, which a short arc would not be, cannot read as a spinner. */
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
  const r = 2.75
  const c = 2 * Math.PI * r
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn('size-4 shrink-0 -rotate-90', className)}>
      <circle cx="8" cy="8" r="6.75" fill="none" strokeWidth="1.5" className={RING_TONE[tone][0]} />
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
          RING_TONE[tone][1],
        )}
      />
    </svg>
  )
}

/** An arc over a track, filled to `share`: the context button's 14 px ring and the cache's 40 px one. */
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
            variant="quiet"
            size="sm"
            aria-label={t('usage.cache.button', { time: label })}
            className={cn(
              ROW_BUTTON,
              'text-hint tabular',
              phase === 'ending' && !running && 'text-warning',
            )}
          />
        }
      >
        <TimerIcon strokeWidth={1.4} />
        {label}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-72.5 gap-0 px-4 py-3.5">
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
 * How much of the context is used, as an arc and its percentage, and a plan limit nearing its end
 * before them. It opens what fills the context, the session's tokens and the plan's limits.
 */
export function ContextButton({
  sessionId,
  agentId,
  idle,
  reports,
  usage,
  limits,
  account,
  onCompact,
}: {
  sessionId: string
  agentId: AgentId
  /** No turn runs, so the agent can break the context down. */
  idle: boolean
  /** Whether the agent breaks its context down at all. */
  reports: boolean
  usage: SessionUsage | null
  limits: PlanLimit[]
  account: AgentAccount | null
  onCompact: (() => void) | null
}) {
  const { t } = useTranslation('composer')
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
    if (reports && idle && usage) loadContext(sessionId, `${usage.used}/${usage.size}`)
  }
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="quiet"
            size="sm"
            aria-label={usage ? t('usage.contextPercent', { percent }) : t('usage.title')}
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
            <Arc share={share} size={14} stroke={1.6} />
            {percent}%
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="max-h-(--available-height) w-85 gap-0 overflow-y-auto px-4 py-3.5"
      >
        {usage && (
          <ContextPart
            sessionId={sessionId}
            usage={usage}
            share={share}
            full={full}
            idle={idle}
            reports={reports}
            onCompact={onCompact}
          />
        )}
        {(limits.length > 0 || account) && (
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
  onCompact,
}: {
  sessionId: string
  usage: SessionUsage
  share: number
  full: boolean
  idle: boolean
  reports: boolean
  onCompact: (() => void) | null
}) {
  const { t } = useTranslation('composer')
  const report = useUsageStore((s) => s.context[sessionId])
  const totals = usage.tokens
  const tone = contextTone(share)
  const key = `${usage.used}/${usage.size}`
  const view = breakdownView(report, key, { reports, idle })
  // A turn that ends under an open popover reads the context it can now break down, as opening
  // the popover does.
  const waiting = !report || (!report.loading && report.key !== key)
  const readNow = reports && idle && waiting
  useEffect(() => {
    if (readNow) loadContext(sessionId, key)
  }, [readNow, sessionId, key])
  const rows = view.kind === 'rows' ? view.rows : null
  const breakdown = view.kind === 'rows' ? report?.breakdown : null
  const lists = breakdown?.lists ?? []
  const busy = view.kind === 'rows' && view.dimmed
  const compactAt = compactsAt(rows, usage.size)
  const retry = () => loadContext(sessionId, key)
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
      {(compactAt !== null || onCompact) && (
        <div className="mt-2.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-small text-tertiary">
            {compactAt !== null && t('usage.context.compactsAt', { percent: compactAt })}
          </span>
          {onCompact && (
            <Button variant="outline" size="sm" onClick={onCompact}>
              {t('usage.context.compact')}
            </Button>
          )}
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
      <CollapsibleTrigger className="group/list flex h-6 w-full items-center gap-1.5 rounded-sm text-secondary outline-none focus-ring">
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

/** The plan and its windows: a bar for each, in the limit colors, then a way to the Usage page. */
function PlanPart({ limits, account }: { limits: PlanLimit[]; account: AgentAccount | null }) {
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
              <span className={level === 'ok' ? 'text-primary' : LIMIT_TEXT[level]}>
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
      <button
        type="button"
        onClick={openUsage}
        className="mt-3 inline-flex w-fit items-center gap-1 rounded-sm font-medium text-primary underline decoration-border-strong underline-offset-3 outline-none focus-ring hover:decoration-current"
      >
        {t('usage.openUsage')}
        <ChevronRightIcon strokeWidth={1.6} className="size-3" />
      </button>
    </div>
  )
}
