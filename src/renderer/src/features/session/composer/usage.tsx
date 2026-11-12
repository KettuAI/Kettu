import { useEffect } from 'react'
import { ArrowRight01Icon, Timer02Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
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
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextWindow,
  type ContextPart as ContextWindowPart,
} from '@renderer/components/affect/context-window'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useCacheLeft, useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import { joinPlanTier } from '@renderer/features/account/model'
import { breakdownView, shownUsage } from '@renderer/features/session/composer/context-bar'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { planReset, usageTone, type UsageTone } from '@renderer/features/sidebar/plan-usage'
import { clockTime, countdown, fullTime, limitLabel, money, tokens } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { limitLevel } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { loadContext, refreshLimits, useUsageStore } from '@renderer/stores/usage'
import { Glyph } from '@renderer/features/shell/glyph'

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

/**
 * The prompt cache's time left on the composer's tray, for a harness that says when its cache
 * expires; amber in the last minute. It opens what the cache saves and when it last wrote.
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
          <button
            type="button"
            aria-label={t('usage.cache.button', { time: label })}
            data-tone={phase === 'ending' && !running ? 'warn' : undefined}
            className="ui-as-tray-link kettu-tray-link--meter"
          />
        }
      >
        <Glyph icon={Timer02Icon} size={14} />
        <span className="tabular">{label}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="kettu-pop w-70">
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
  const share = Math.min(1, Math.max(0, left / cache.ttl))
  return (
    <div className="kettu-cache">
      <svg className="kettu-cache__arc" viewBox="0 0 64 36" aria-hidden>
        <path d="M6 32a26 26 0 0 1 52 0" pathLength={100} className="kettu-cache__track" />
        <path
          d="M6 32a26 26 0 0 1 52 0"
          pathLength={100}
          className="kettu-cache__fill"
          strokeDasharray={`${share * 100} 100`}
        />
      </svg>
      <b>{t('usage.cache.title')}</b>
      <span className="kettu-cache__line tabular">
        {expired ? (
          t(cache.estimate ? 'usage.cache.likelyExpired' : 'usage.cache.expired')
        ) : (
          <Trans
            t={t}
            i18nKey={cache.estimate ? 'usage.cache.leftLineAbout' : 'usage.cache.leftLine'}
            values={{ time: countdown(left), tokens: read }}
            components={{ time: <b /> }}
          />
        )}
      </span>
      <span className="kettu-cache__note">
        {expired
          ? t(cache.estimate ? 'usage.cache.ifExpired' : 'usage.cache.costExpired', {
              tokens: read,
            })
          : t('usage.cache.explain')}
      </span>
      <span className="kettu-cache__foot tabular">
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
      </span>
    </div>
  )
}

/** A usage level's place among the four colors the context ring and the plan bars share. */
const METER = { low: 'ok', medium: 'mid', high: 'high', critical: 'full' } as const

const LIMIT_METER = { ok: 'mid', warn: 'high', bad: 'full' } as const

/**
 * How much of the context is used, as a ring and its percentage, and a plan limit nearing its end
 * before them, on the composer's tray. It opens affectUI's Context Window over what fills the
 * context, then the session's tokens and the plan's limits.
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
  model,
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
  /** The model's name, for the card's chip. */
  model: string | null
}) {
  const { t } = useTranslation('composer')
  // The tray names a limit only from 70% on; below that it stays in the popover.
  const nearest = warningLimit(limits)
  const warning = nearest && limitLevel(nearest) !== 'ok' ? nearest : null
  // An account of another kind has no plan; an unknown one shows the limits the agent reports.
  const subscribed = account ? account.kind === 'account' : limits.length > 0
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
          <button
            type="button"
            aria-label={
              usage
                ? t(read?.error ? 'usage.contextPercentStale' : 'usage.contextPercent', { percent })
                : t('usage.title')
            }
            title={read?.error ? t('usage.breakdown.refreshFailed') : undefined}
            className="ui-as-tray-link kettu-tray-link--meter"
          />
        }
      >
        {warning && (
          <span
            key={`${warning.window}-${warning.usedPercent}`}
            className="kettu-tray-limit"
            data-level={LIMIT_METER[limitLevel(warning)]}
          >
            {isShortWindow(warning.window) ? t(SHORT_WINDOW[warning.window]) : limitLabel(warning)}{' '}
            {warning.usedPercent !== null && `${Math.round(warning.usedPercent)}%`}
          </span>
        )}
        {usage && (
          <>
            <MeterRing share={share} level={METER[tone]} />
            <span className="tabular">
              {read?.error && '≈'}
              {t('usage.contextShort', { percent })}
            </span>
          </>
        )}
      </PopoverTrigger>
      {/* A long list scrolls above the tray rather than flipping the card beside it. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionAvoidance={{ fallbackAxisSide: 'none' }}
        className="kettu-pop max-h-(--available-height) w-80 overflow-y-auto"
      >
        <div className="kettu-ctx">
          {shown && (
            <ContextPart
              sessionId={sessionId}
              agentId={agentId}
              usage={shown}
              idle={idle}
              reports={reports}
              live={live}
              report={read}
              managed={context !== undefined && direct}
              model={model}
            />
          )}
          {shown && <SessionLine usage={shown} />}
          {subscribed && <PlanLimits limits={limits} account={account} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The tray's ring: a pie on a disc tinted in the level's color, 14 px. */
function MeterRing({ share, level }: { share: number; level: string }) {
  const r = 5.5
  const c = 2 * Math.PI * r
  const used = Math.min(1, Math.max(0, share))
  return (
    <svg className="kettu-meter-ring" data-level={level} viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="6.5" className="kettu-meter-ring__disc" />
      <circle
        cx="7"
        cy="7"
        r={r / 2}
        className="kettu-meter-ring__pie"
        strokeWidth={r}
        strokeDasharray={`${used * (c / 2)} ${c}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

const SKILLS = /^skills$/i
const MEMORY_FILES = /^memory files$/i
// What fits a list row of the context card beside its count.
const PATH_ROOM = 36

/** A long path cut in the middle, so its file's name stays whole: `~/.claude/pr…MEMORY.md`. */
function middlePath(path: string): string {
  if (path.length <= PATH_ROOM) return path
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const head = PATH_ROOM - name.length - 1
  return head > 0 ? `${path.slice(0, head)}…${name}` : path
}

/** A list's token count as the agent wrote it, such as "1.2k", as a number. */
function parseTokens(text: string): number {
  const match = /([\d.,]+)\s*([kKmM])?/.exec(text)
  if (!match) return 0
  const n = Number(match[1]!.replace(/,/g, ''))
  const unit = match[2]?.toLowerCase()
  return Number.isFinite(n) ? n * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1) : 0
}

function ContextPart({
  sessionId,
  agentId,
  usage,
  idle,
  reports,
  live,
  report,
  managed,
  model,
}: {
  sessionId: string
  agentId: AgentId
  usage: SessionUsage
  idle: boolean
  reports: boolean
  live: boolean
  report: ContextReport | undefined
  managed: boolean
  model: string | null
}) {
  const { t } = useTranslation('composer')
  const key = `${usage.used}/${usage.size}`
  const view = breakdownView(report, key, { reports, idle, live })
  // Managed reports are refreshed by the host, independently of this popover's lifetime.
  const waiting = !report || (!report.loading && report.key !== key)
  const readNow = reports && !managed && (idle || live) && waiting
  useEffect(() => {
    if (readNow) loadContext(sessionId, key)
  }, [readNow, sessionId, key])
  const rows = view.kind === 'rows' ? view.rows : null
  const lists = view.kind === 'rows' ? (report?.breakdown?.lists ?? []) : []
  const busy = view.kind === 'rows' && view.dimmed
  const retry = () => loadContext(sessionId, key, true)
  const listOf = (name: string) => lists.find((l) => l.name.toLowerCase() === name.toLowerCase())
  const parts: ContextWindowPart[] = rows
    ? rows
        .filter((row) => row.part.kind !== 'free')
        .map((row) => {
          // Skills get a page of their own, so their row lists none of them.
          const skills = SKILLS.test(row.name)
          const list = skills ? undefined : listOf(row.name)
          const paths = MEMORY_FILES.test(row.name)
          return {
            id: row.name,
            label: row.name,
            tokens: row.tokens,
            locked: true,
            ...(skills ? { link: true } : {}),
            ...(row.part.kind === 'buffer'
              ? { color: 'var(--composer-faint)', reserved: true }
              : {}),
            ...(list
              ? {
                  items: list.items.map((item, index) => ({
                    id: String(index),
                    label: paths
                      ? middlePath(item.name)
                      : item.detail
                        ? `${item.name} · ${item.detail}`
                        : item.name,
                    tokens: parseTokens(item.tokens),
                    ...(paths ? { title: item.name } : {}),
                  })),
                }
              : {}),
          }
        })
    : [{ id: 'used', label: t('usage.context.used'), tokens: usage.used, locked: true }]
  const unlisted = lists.filter(
    (l) =>
      !SKILLS.test(l.name) && !rows?.some((r) => r.name.toLowerCase() === l.name.toLowerCase()),
  )
  return (
    <>
      <div aria-busy={busy} className="kettu-ctx__window" data-busy={busy || undefined}>
        <ContextWindow
          parts={parts}
          limit={usage.size}
          title={t('usage.context.title')}
          model={model ?? undefined}
          modelIcon={model ? <AgentMark agent={agentId} size={12} /> : undefined}
          readOnly
          steadyHead
          labels={{
            free: (n) => t('usage.window.free', { n }),
            left: (n) => t('usage.window.left', { n }),
            over: (n) => t('usage.window.over', { n }),
            full: t('usage.window.full'),
            of: (n) => t('usage.window.of', { n }),
            share: (percent) => t('usage.window.share', { percent }),
            used: (used, cap, percent) => t('usage.window.used', { used, cap, percent }),
            nothing: t('usage.window.nothing'),
          }}
        />
      </div>
      {/* A refresh in progress adds no line: the card opens upward, so a passing line jolts it. */}
      {view.kind === 'rows' && view.stale && (report?.error || (!live && !idle)) && (
        <p className="kettu-ctx__note">
          {t(report?.error ? 'usage.breakdown.refreshFailed' : 'usage.breakdown.stale')}
        </p>
      )}
      {view.kind === 'loading' && <BreakdownRows />}
      {view.kind === 'error' && (
        <div className="kettu-ctx__pad">
          <BreakdownError error={view.error} onRetry={retry} />
        </div>
      )}
      {view.kind === 'betweenTurns' && (
        <p className="kettu-ctx__note">{t('usage.breakdown.betweenTurns')}</p>
      )}
      {unlisted.length > 0 && (
        <div className="kettu-ctx__pad">
          {unlisted.map((list) => (
            <ListPart key={list.name} list={list} />
          ))}
        </div>
      )}
    </>
  )
}

/** The session's tokens and cost on one row, with the kinds of tokens in its tooltip. */
function SessionLine({ usage }: { usage: SessionUsage }) {
  const { t } = useTranslation('composer')
  const totals = usage.tokens
  if (!totals && !usage.cost) return null
  const parts = [
    totals && t('usage.context.tokens', { tokens: tokens(totals.total) }),
    usage.cost && `≈ ${money(usage.cost.amount, usage.cost.currency)}`,
  ].filter(Boolean)
  const line = (
    <div className="kettu-ctx__session">
      <span>{t('usage.context.session')}</span>
      <span className="tabular">{parts.join(' · ')}</span>
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

/** The plan's limits under the context: the tier as a chip, then each window with its bar. */
function PlanLimits({ limits, account }: { limits: PlanLimit[]; account: AgentAccount | null }) {
  const { t } = useTranslation('composer')
  const now = useNow()
  const plan = account?.label ? joinPlanTier(account.label, account.tier) : null
  return (
    <div className="kettu-ctx__plan">
      <div className="kettu-ctx__plan-head">
        <span>{t('usage.limits.title')}</span>
        {plan && <span className="kettu-ctx__tier">{plan}</span>}
      </div>
      {limits.map((limit) => {
        const used = limit.usedPercent ?? 0
        return (
          <div key={limit.window} className="kettu-limit" data-level={METER[usageTone(limit)]}>
            <div className="kettu-limit__row">
              <span className="kettu-limit__label">{limitLabel(limit)}</span>
              {limit.resetsAt && (
                <Tooltip>
                  <TooltipTrigger render={<span className="kettu-limit__reset" />}>
                    {planReset(limit.resetsAt, now)}
                  </TooltipTrigger>
                  <TooltipContent>
                    {t('usage.limits.resets', { time: fullTime(limit.resetsAt) })}
                  </TooltipContent>
                </Tooltip>
              )}
              <span className="kettu-limit__value tabular">
                {limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`}
              </span>
            </div>
            <div
              className="kettu-limit__bar"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(used)}
              aria-label={t('usage.limits.used', { limit: limitLabel(limit) })}
            >
              <span style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The skeleton rows while no breakdown is here, and the failure with its Retry at the end. */
function BreakdownRows() {
  const { t } = useTranslation('composer')
  return (
    <div aria-label={t('usage.breakdown.loading')} className="kettu-ctx__pad flex flex-col">
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
        <Glyph
          icon={ArrowRight01Icon}
          size={12}
          className="shrink-0 text-tertiary transition-transform duration-(--duration-fast) group-data-panel-open/list:rotate-90 motion-reduce:transition-none"
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
  const plan = account?.label ? joinPlanTier(account.label, account.tier) : null
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
                    {planReset(limit.resetsAt, now)}
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
