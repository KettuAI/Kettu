import { useEffect, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  RefreshIcon,
  Timer02Icon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { AgentAccount, ContextList, PlanLimit } from '@shared/agent-host'
import {
  CONTEXT_REFRESH_MS,
  type ContextDefinitionEstimate,
  type ContextEstimates,
  type ContextReport,
} from '@shared/context'
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
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useCacheLeft, useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import { joinPlanTier } from '@renderer/features/account/model'
import { breakdownView, shownUsage } from '@renderer/features/session/composer/context-bar'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { planResetShort, usageTone, type UsageTone } from '@renderer/features/sidebar/plan-usage'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import {
  clockTime,
  countdown,
  fullTime,
  limitLabel,
  limitShort,
  money,
  planAmount,
  tokens,
  windowLabel,
} from '@renderer/lib/format'
import { errorMessage, host, sessionHost } from '@renderer/lib/host'
import { limitLevel, limitPercent, shownPercent } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import { loadContext, refreshLimits, useUsageStore } from '@renderer/stores/usage'
import { toggleSidePane } from '@renderer/stores/view'
import { REQUESTS_ICON } from '@renderer/features/requests/icon'
import { readsModelRequests } from '@renderer/features/requests/support'
import { useSessionView } from '@renderer/features/session/use-thread'
import { Glyph } from '@renderer/features/shell/glyph'
import { groupPlanLimits, type PlanLimitGroup, type PlanLimitItem } from './plan-limit-groups'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The context's usage level, which colors its ring: see usageTone for the four. */
const contextTone = (share: number): UsageTone =>
  usageTone({ usedPercent: share * 100, state: 'ok' })

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
  const time = useCacheLeft(timed?.expiresAt ?? null, countdown, true)
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
            data-expired={expired ? '' : undefined}
            className="ui-as-tray-link kettu-tray-link--meter kettu-tray-link--cache"
          />
        }
      >
        <Glyph icon={Timer02Icon} size={14} className="kettu-tray-cache__icon" />
        <span className="tabular kettu-tray-cache__label">{label}</span>
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
  const left = useCacheLeft(cache.expiresAt, (ms) => ms, true) ?? 0
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
  closed,
  reports,
  direct,
  live,
  estimates,
  usage,
  context,
  limits,
  holding,
  account,
  model,
  subagent,
}: {
  sessionId: string
  agentId: AgentId
  /** No turn runs. */
  idle: boolean
  /** The session is not attached to its agent, so nothing refreshes its context. */
  closed: boolean
  /** Whether the agent breaks its context down at all. */
  reports: boolean
  /** Whether the agent reads its context through its connection, without a fork. */
  direct: boolean
  /** Whether a running turn's context can be read through the agent's connection. */
  live: boolean
  estimates?: boolean
  usage: SessionUsage | null
  context?: ContextReport
  limits: PlanLimit[]
  /** Of `limits`, those that hold this session's model back, which the tray warns about. */
  holding: PlanLimit[]
  account: AgentAccount | null
  /** The model's name, for the card's chip. */
  model: string | null
  /** A sub-agent's context: its agent counts the total but breaks down only the parent's. */
  subagent?: boolean
}) {
  const { t } = useTranslation('composer')
  const limitView = useLimitView()
  const [open, setOpen] = useState(false)
  // The tray names a limit only from 70% on; below that it stays in the popover.
  const nearest = warningLimit(holding)
  const warning = nearest && limitLevel(nearest) !== 'ok' ? nearest : null
  // An account of another kind has no plan; an unknown one shows the limits the agent reports.
  const subscribed = account ? account.kind === 'account' : limits.length > 0
  const cached = useUsageStore((s) => s.context[sessionId])
  // A closed session's own report is the one stored with it: only the host pushes newer ones.
  const pushed = closed ? undefined : context
  const read = pushed ?? (closed ? closedReport(context, cached) : cached)
  const shown = shownUsage(usage, read?.breakdown ?? null)
  // Older hosts answer on demand; current hosts push every direct snapshot with the session. A
  // closed session's agent is asked only from the popover, since a read starts it.
  const key = usage && usage.size > 0 ? `${usage.used}/${usage.size}` : null
  const waiting = !!key && (!read || (!read.loading && read.key !== key))
  const readNow = direct && !closed && !context && key !== null && !read?.error && waiting
  useEffect(() => {
    if (readNow && key) loadContext(sessionId, key)
  }, [readNow, sessionId, key])
  if (!usage && !warning) return null
  const share = shown && shown.size > 0 ? shown.used / shown.size : 0
  const tone = contextTone(share)
  const percent = Math.round(share * 100)
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    refreshLimits(agentId, sessionHost(sessionId)).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
    const own = closed ? read : context
    const stale =
      !own?.breakdown || own.error || Date.now() - own.breakdown.observedAt >= CONTEXT_REFRESH_MS
    if (reports && (idle || live) && usage && (!own || (!own.loading && stale))) {
      loadContext(sessionId, `${usage.used}/${usage.size}`, direct)
    }
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
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
            {limitShort(warning)}{' '}
            {warning.usedPercent !== null && `${limitPercent(warning, limitView)}%`}
          </span>
        )}
        {usage && (
          <>
            <MeterRing share={share} level={METER[tone]} />
            <span className="tabular kettu-tray-meter__percent">
              {read?.error && '≈'}
              <Trans
                t={t}
                i18nKey="usage.contextShort"
                values={{ percent }}
                components={{ word: <span className="kettu-tray-meter__word" /> }}
              />
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
              managed={pushed !== undefined && direct}
              model={model}
              subagent={subagent}
            />
          )}
          {shown && estimates && (
            <ContextEstimatePart
              key={`${sessionId}/${agentId}`}
              sessionId={sessionId}
              closed={closed}
            />
          )}
          <UsageLines sessionId={sessionId} usage={shown} />
          {readsModelRequests(agentId) && (
            <button
              type="button"
              className="kettu-ctx__link"
              onClick={() => {
                setOpen(false)
                toggleSidePane(sessionId, 'requests', true)
              }}
            >
              <span className="kettu-ctx__link-name">
                <Glyph icon={REQUESTS_ICON} size={14} />
                {t('usage.everyRequest')}
              </span>
              <Glyph icon={ArrowRight01Icon} size={13} />
            </button>
          )}
          {subscribed && <PlanLimits limits={limits} holding={holding} account={account} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A closed session's report: the one stored with it, until a read from the popover brings a newer
 * breakdown; a read that runs or failed shows on the stored rows.
 */
function closedReport(
  stored: ContextReport | undefined,
  read: ContextReport | undefined,
): ContextReport | undefined {
  if (!read || !stored?.breakdown) return read ?? stored
  if (read.breakdown && read.breakdown.observedAt >= stored.breakdown.observedAt) return read
  return { ...stored, loading: read.loading, error: read.error }
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
  subagent,
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
  subagent?: boolean
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
          const list = listOf(row.name)
          const paths = MEMORY_FILES.test(row.name)
          // A skill's source is the agent's own key, such as `syncedSkills`; a plugin's skill
          // already names its plugin.
          const bare = SKILLS.test(row.name)
          return {
            id: row.name,
            label: row.name,
            tokens: row.tokens,
            locked: true,
            ...(row.part.kind === 'buffer'
              ? { color: 'var(--composer-faint)', reserved: true }
              : {}),
            ...(list
              ? {
                  items: list.items.map((item, index) => ({
                    id: String(index),
                    label: paths
                      ? middlePath(item.name)
                      : item.detail && !bare
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
    (l) => !rows?.some((r) => r.name.toLowerCase() === l.name.toLowerCase()),
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
      {subagent && view.kind === 'none' && (
        <p className="kettu-ctx__note">{t('usage.breakdown.subagent')}</p>
      )}
      {view.kind === 'loading' && <BreakdownRows label={t('usage.breakdown.loading')} />}
      {view.kind === 'error' && (
        <div className="kettu-ctx__pad">
          <BreakdownError
            message={t('usage.breakdown.error', { error: view.error })}
            onRetry={retry}
          />
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

const hitPercent = (share: number | null): string =>
  share === null ? '\u2014' : `${Math.round(share * 100)}%`

/**
 * The session's tokens and its latest request as two blocks of one shape: the name and total on a
 * line, then input, output and cache hit in the same three columns, so the figures line up.
 */
function UsageLines({ sessionId, usage }: { sessionId: string; usage: SessionUsage | null }) {
  const { t } = useTranslation('composer')
  const last = useSessionView(sessionId)?.lastRequest
  const totals = usage?.tokens ?? null
  const session = usage && (totals || usage.cost)
  if (!session && !last) return null
  const sessionInput = totals
    ? totals.input + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0)
    : 0
  const sessionHit =
    totals && totals.cacheRead !== null && sessionInput > 0 ? totals.cacheRead / sessionInput : null
  const lastInput = last ? (last.input ?? 0) + (last.cacheRead ?? 0) + (last.cacheWrite ?? 0) : 0
  const lastHit =
    last && last.cacheRead !== null && lastInput > 0 ? last.cacheRead / lastInput : null
  const sessionBlock = session && (
    <UsageBlock
      label={t('usage.context.session')}
      total={[
        totals && t('usage.context.tokens', { tokens: tokens(totals.total) }),
        usage.cost && `\u2248 ${money(usage.cost.amount, usage.cost.currency)}`,
      ]
        .filter(Boolean)
        .join(' \u00b7 ')}
      figures={
        totals && { input: tokens(sessionInput), output: tokens(totals.output), hit: sessionHit }
      }
    />
  )
  return (
    <div className="kettu-ctx__usage">
      {sessionBlock && totals ? (
        <Tooltip>
          <TooltipTrigger render={sessionBlock} />
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
      ) : (
        sessionBlock
      )}
      {last && (
        <UsageBlock
          label={t('usage.lastRequest.title')}
          title={clockTime(last.at)}
          total={
            last.output === null
              ? t('usage.lastRequest.running')
              : t('usage.context.tokens', { tokens: tokens(lastInput + last.output) })
          }
          figures={{
            input: tokens(lastInput),
            output: last.output === null ? '\u2026' : tokens(last.output),
            hit: lastHit,
          }}
        />
      )}
    </div>
  )
}

function UsageBlock({
  label,
  total,
  title,
  figures,
  ...trigger
}: {
  label: string
  total: string
  title?: string
  figures: { input: string; output: string; hit: number | null } | null
}) {
  const { t } = useTranslation('composer')
  return (
    // The rest are a tooltip trigger's props, when the block opens one.
    <div {...trigger} className="kettu-ctx__block" title={title}>
      <div className="kettu-ctx__block-head">
        <span>{label}</span>
        <span className="tabular">{total}</span>
      </div>
      {figures && (
        <dl className="kettu-ctx__figures tabular">
          <div>
            <dt>{t('usage.context.input')}</dt>
            <dd>{figures.input}</dd>
          </div>
          <div>
            <dt>{t('usage.context.output')}</dt>
            <dd>{figures.output}</dd>
          </div>
          <div>
            <dt>{t('usage.context.cacheHit')}</dt>
            <dd>{hitPercent(figures.hit)}</dd>
          </div>
        </dl>
      )}
    </div>
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

/** 根据条目在组内的展示模式生成紧凑且不重复的窗名 */
function itemLabel(item: PlanLimitItem): string {
  if (item.labelMode === 'scope' && item.parts.scope) return item.parts.scope
  if (item.labelMode === 'window' && item.parts.kind) {
    return windowLabel({ kind: item.parts.kind, count: item.parts.count, scope: null })
  }
  return limitLabel(item.limit)
}

/**
 * 分组双轨卡片列表：按模型组/服务商聚合，组名独占顶行彻底避免折行，组内窗口左右双列并排对照。
 * 同时供上下文弹窗（PlanLimits）与侧边栏账号悬浮卡（PlanPart）复用。
 */
function PlanLimitGroups({
  limits,
  holding,
}: {
  limits: PlanLimit[]
  /** 当前会话所选模型对应的受限窗口；传入时会将对应组标为当前并置顶 */
  holding?: PlanLimit[]
}) {
  const { t } = useTranslation(['composer', 'common', 'usage'])
  const now = useNow()
  const view = useLimitView()
  const groups = groupPlanLimits(limits, holding)
  if (groups.length === 0) return null

  const headingOf = (group: PlanLimitGroup): string | null => {
    if (group.kind === 'solo') return null
    if (group.kind === 'group') return group.title
    if (group.kind === 'all') return t('usage.limits.allModels')
    if (group.windowKind === 'seven_day') return t('usage.limits.modelWeekly')
    if (group.windowKind) {
      return t('usage.limits.modelWindow', {
        window: windowLabel({ kind: group.windowKind, count: null, scope: null }),
      })
    }
    return null
  }

  return (
    <div className="kettu-plan-groups">
      {groups.map((group) => {
        const heading = headingOf(group)
        const modelsTip = group.models.length > 0 ? group.models.join(' · ') : null
        const single = group.items.length === 1
        return (
          <div
            key={group.id}
            className="kettu-plan-group"
            data-current={group.current ? '' : undefined}
            data-solo={group.kind === 'solo' ? '' : undefined}
          >
            {heading && (
              <div className="kettu-plan-group__head">
                <span className="kettu-plan-group__name" title={heading}>
                  {heading}
                </span>
                {group.current ? (
                  modelsTip ? (
                    <Tooltip>
                      <TooltipTrigger render={<span className="kettu-plan-group__badge" />}>
                        {t('usage.limits.current')}
                      </TooltipTrigger>
                      <TooltipContent>{modelsTip}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="kettu-plan-group__badge">{t('usage.limits.current')}</span>
                  )
                ) : (
                  modelsTip && (
                    <Tooltip>
                      <TooltipTrigger render={<span className="kettu-plan-group__models" />}>
                        {t('usage.limits.models', { count: group.models.length })}
                      </TooltipTrigger>
                      <TooltipContent>{modelsTip}</TooltipContent>
                    </Tooltip>
                  )
                )}
              </div>
            )}
            <div className="kettu-plan-group__grid" data-single={single ? '' : undefined}>
              {group.items.map((item) => {
                const { limit } = item
                const shown = shownPercent(Math.round(limit.usedPercent ?? 0), view)
                const fill = limit.usedPercent === null ? 0 : Math.min(100, Math.max(0, shown))
                const reset = limit.resetsAt ? planResetShort(limit.resetsAt, now) : null
                const unit =
                  limit.amount?.unit === 'credits'
                    ? t('usage:limits.units.credits')
                    : limit.amount?.unit === 'requests'
                      ? t('usage:limits.units.premiumRequests')
                      : limit.amount?.unit
                const amountText = limit.amount
                  ? planAmount(
                      limit.amount.used,
                      limit.amount.total,
                      limit.amount.unit,
                      unit ?? limit.amount.unit,
                    )
                  : null
                return (
                  <div
                    key={limit.window}
                    className="kettu-limit"
                    data-level={METER[usageTone(limit)]}
                  >
                    <div className="kettu-limit__row">
                      <span className="kettu-limit__label" title={limitLabel(limit)}>
                        {itemLabel(item)}
                      </span>
                      <span className="kettu-limit__value tabular">
                        {limit.usedPercent === null ? '—' : `${shown}%`}
                      </span>
                    </div>
                    <div
                      className="kettu-limit__bar"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={fill}
                      aria-label={t(view === 'left' ? 'usage.limits.left' : 'usage.limits.used', {
                        limit: limitLabel(limit),
                      })}
                    >
                      <span
                        data-tiny={fill > 0 && fill <= 3 ? '' : undefined}
                        style={{ width: `${fill}%` }}
                      />
                    </div>
                    {(reset || amountText) && (
                      <div className="kettu-limit__meta">
                        {reset && limit.resetsAt && (
                          <Tooltip>
                            <TooltipTrigger
                              render={<span className="kettu-limit__reset tabular" />}
                            >
                              <Glyph icon={RefreshIcon} size={10} />
                              <span>{reset}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t('usage.limits.resets', { time: fullTime(limit.resetsAt) })}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {amountText && (
                          <span className="kettu-limit__amount tabular" title={amountText}>
                            {amountText}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 上下文弹窗底部的套餐限额区块：标题、可点击切换的已用/剩余口径、套餐芯片与分组双轨卡片 */
function PlanLimits({
  limits,
  holding,
  account,
}: {
  limits: PlanLimit[]
  holding: PlanLimit[]
  account: AgentAccount | null
}) {
  const { t } = useTranslation(['composer', 'common'])
  const view = useLimitView()
  const plan = account?.label ? joinPlanTier(account.label, account.tier) : null
  const nextView = view === 'left' ? 'used' : 'left'
  const nextLabel = t(nextView === 'left' ? 'common:planView.left' : 'common:planView.used')
  return (
    <div className="kettu-ctx__plan">
      <div className="kettu-ctx__plan-head">
        <span className="kettu-ctx__plan-title">
          <span>{t('usage.limits.title')}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="kettu-ctx__plan-view"
                  aria-label={t('usage.limits.toggleView', { view: nextLabel })}
                  onClick={() =>
                    void useSettingsStore.getState().update({ usage: { limits: nextView } })
                  }
                />
              }
            >
              {'· '}
              {t(view === 'left' ? 'common:planView.left' : 'common:planView.used')}
            </TooltipTrigger>
            <TooltipContent>{t('usage.limits.toggleView', { view: nextLabel })}</TooltipContent>
          </Tooltip>
        </span>
        {plan && <span className="kettu-ctx__tier">{plan}</span>}
      </div>
      <PlanLimitGroups limits={limits} holding={holding} />
    </div>
  )
}

/** The skeleton rows while no breakdown is here, and the failure with its Retry at the end. */
function BreakdownRows({ label }: { label: string }) {
  return (
    <div aria-label={label} className="kettu-ctx__pad flex flex-col">
      {[4 / 5, 3 / 5, 2 / 3].map((width) => (
        <div key={width} className="flex h-6 items-center">
          <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
        </div>
      ))}
    </div>
  )
}

function BreakdownError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-start gap-2 text-small text-tertiary">
      <p className="min-w-0 flex-1">{message}</p>
      <Button variant="outline" size="xs" onClick={onRetry} className="shrink-0">
        {t('actions.retry')}
      </Button>
    </div>
  )
}

function ListPart({ list }: { list: ContextList }) {
  const empty = list.items.length === 0
  return (
    <Collapsible>
      <CollapsibleTrigger
        disabled={empty}
        className="group/list -mx-2 flex h-6 w-[calc(100%+1rem)] items-center gap-1.5 rounded-md px-2 text-secondary outline-none transition-colors duration-(--duration-fast) enabled:hover:bg-hover focus-visible:bg-hover focus-ring"
      >
        <Glyph
          icon={ArrowRight01Icon}
          size={12}
          className={cn(
            'shrink-0 text-tertiary transition-transform duration-(--duration-fast) group-data-panel-open/list:rotate-90 motion-reduce:transition-none',
            empty && 'invisible',
          )}
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

type EstimateReading = { estimates: ContextEstimates | null } | { error: string }

/**
 * What the agent can load, sized by estimate: a section of its own under the measured context,
 * since these sizes are of everything available and no part of the total above.
 */
function ContextEstimatePart({ sessionId, closed }: { sessionId: string; closed: boolean }) {
  const { t } = useTranslation('composer')
  const [reading, setReading] = useState<EstimateReading | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (closed) return
    let current = true
    host('sessions.contextEstimates', { sessionId }).then(
      (estimates) => {
        if (current) setReading({ estimates })
      },
      (error: unknown) => {
        if (current) setReading({ error: errorMessage(error) })
      },
    )
    return () => {
      current = false
    }
  }, [attempt, closed, sessionId])

  const estimates = reading && 'estimates' in reading ? reading.estimates : null
  const disconnected = closed || (reading !== null && 'estimates' in reading && !estimates)
  const failed = !disconnected && reading !== null && !estimates?.skills && !estimates?.mcpServers
  return (
    <section className="kettu-ctx__defs" aria-label={t('usage.estimates.title')}>
      <div className="kettu-ctx__defs-head">
        <span>{t('usage.estimates.title')}</span>
        <span className="kettu-ctx__tag">{t('usage.estimates.tag')}</span>
      </div>
      {disconnected ? (
        <p className="kettu-ctx__defs-note">{t('usage.estimates.disconnected')}</p>
      ) : !reading ? (
        <div aria-label={t('usage.estimates.loading')}>
          {[2 / 5, 3 / 5].map((width) => (
            <div key={width} className="kettu-ctx__def">
              <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
            </div>
          ))}
        </div>
      ) : failed ? (
        <BreakdownError
          message={
            'error' in reading
              ? t('usage.breakdown.error', { error: reading.error })
              : t('usage.estimates.readFailed')
          }
          onRetry={() => {
            setReading(null)
            setAttempt((n) => n + 1)
          }}
        />
      ) : (
        <>
          <EstimateList name={t('usage.estimates.skills')} items={estimates?.skills ?? null} />
          <EstimateList
            name={t('usage.estimates.mcpServers')}
            items={estimates?.mcpServers ?? null}
          />
          <p className="kettu-ctx__defs-note">{t('usage.estimates.note')}</p>
        </>
      )}
    </section>
  )
}

/** One kind of definition: its estimated size, opening the size of each. */
function EstimateList({
  name,
  items,
}: {
  name: string
  items: ContextDefinitionEstimate[] | null
}) {
  const { t } = useTranslation('composer')
  const known = items?.map((item) => item.tokens).filter((count) => count !== null) ?? []
  const total = known.reduce((sum, count) => sum + count, 0)
  const estimate = (count: number | null): string => {
    if (count === null) return t('usage.estimates.unavailable')
    return count === 0 ? tokens(count) : t('usage.estimates.count', { count: tokens(count) })
  }
  const unknown = !items || (items.length > 0 && known.length === 0)
  const partial = !unknown && known.length < items.length
  const empty = !items || items.length === 0
  return (
    <Collapsible>
      <CollapsibleTrigger disabled={empty} className="group/def kettu-ctx__def">
        <span className="kettu-ctx__def-swatch" aria-hidden />
        <span className="kettu-ctx__def-name">
          <span className="truncate">{name}</span>
          {!empty && (
            <Glyph
              icon={ArrowDown01Icon}
              size={12}
              className="shrink-0 transition-transform duration-(--duration-fast) group-data-panel-open/def:rotate-180 motion-reduce:transition-none"
            />
          )}
        </span>
        {partial && <span className="kettu-ctx__tag">{t('usage.estimates.partial')}</span>}
        <span className="kettu-ctx__def-value tabular">{estimate(unknown ? null : total)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <ul className="kettu-ctx__def-items tabular">
          {(items ?? []).map((item, index) => (
            <li key={index}>
              <span className="truncate" title={item.name}>
                {item.name}
              </span>
              <span>{estimate(item.tokens)}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 侧边栏账号悬浮卡中的套餐与限额详情，复用统一的分组双轨卡片布局 */
export function PlanPart({
  limits,
  account,
}: {
  limits: PlanLimit[]
  account: AgentAccount | null
}) {
  const { t } = useTranslation(['composer', 'common'])
  const view = useLimitView()
  const plan = account?.label ? joinPlanTier(account.label, account.tier) : null
  return (
    <div className="flex flex-col gap-2 text-hint">
      <div className="flex items-center justify-between gap-2">
        <span className="text-small font-medium text-tertiary">
          {t('usage.limits.title')}
          <span className="font-normal opacity-80">
            {' · '}
            {t(view === 'left' ? 'common:planView.left' : 'common:planView.used')}
          </span>
        </span>
        {plan && <span className="kettu-ctx__tier">{plan}</span>}
      </div>
      <PlanLimitGroups limits={limits} />
    </div>
  )
}
