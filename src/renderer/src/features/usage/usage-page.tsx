import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChartNoAxesColumnIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import type { UsageScope } from '@shared/usage'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { exportDiagnostics } from '@renderer/app/actions'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CornerControls, NoDrag } from '@renderer/features/shell/top-bar'
import {
  basename,
  bytes,
  count,
  exactCount,
  longAgo,
  percent,
  tokens,
  usd,
} from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { isMac } from '@renderer/lib/platform'
import { useClock, useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  loadUsagePage,
  setUsageFilters,
  syncUsage,
  usageDayTurned,
  usagePageShown,
  useUsageStore,
  type UsagePage as PageData,
} from '@renderer/stores/usage'
import { useViewStore } from '@renderer/stores/view'
import { HeatLegend, Heatmap, TrendAxis, TrendChart, TrendLegend } from './charts'
import {
  addDays,
  busiest,
  clocksChange,
  dayOf,
  dayTotals,
  figures,
  firstDayOfWeek,
  heatmapRange,
  hourBars,
  hourLabels,
  hoursSoFar,
  ledgerCell,
  legendHidden,
  legendHides,
  metricKind,
  metricValue,
  modelRows,
  namesYear,
  NO_SERIES,
  projectRows,
  RANGE_KINDS,
  seriesOf,
  shownSeries,
  shownTotals,
  tokensPerRequest,
  trend,
  unpricedTokens,
  wholeMonth,
  type BreakdownRow,
  type DayTotal,
  type LegendChoice,
  type Metric,
  type MetricKind,
  type RangeKind,
  type TrendBar,
} from './model'
import { Panel, PanelHead, Readout } from './panel'
import { PlanLimits } from './plan-limits'
import { RangePicker } from './range-picker'

/** A one-day range's totals per hour, and the hour starts they were summed over. */
interface HourTotals {
  totals: DayTotal[]
  starts: number[]
  /** The clocks change that day, so its hours name their time zones. */
  zoned: boolean
}

/** A scan with less than this to read is over before its progress is worth showing. */
const IMPORT_SHOWN = 50_000_000

/** Two panels in a row: the wider one first. */
const PANEL_ROW = 'grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]'

/** The usage page: a dashboard of the tokens the agents used, for a chosen agent and range. */
export default function UsagePage() {
  const { t } = useTranslation('usage')
  const unavailable = useUsageStore((s) => s.status?.unavailable ?? false)
  const importing = useUsageStore((s) => (s.status?.scanning?.bytes ?? 0) >= IMPORT_SHOWN)
  const page = useUsageStore((s) => s.page)
  const error = useUsageStore((s) => s.error)
  // Kettu only can be empty while the logs are not; the filters must stay to switch back.
  const narrowed = useUsageStore((s) => s.filters.scope === 'kettu' && !!s.status?.fromComputer)

  useEffect(() => {
    usagePageShown(true)
    return () => usagePageShown(false)
  }, [])

  const empty = !!page && page.summary.first === null && !narrowed
  let body: ReactNode
  if (unavailable) {
    body = <Unavailable />
  } else if (empty) {
    // A first import fills the page as it goes; until then its progress stands in for it.
    body = importing ? <ImportProgress alone /> : <FirstRun />
  } else if (!page) {
    body = (
      <>
        <Filters page={null} used={NO_DAYS} />
        {error ? <ReadFailed error={error} kept={false} /> : <LoadingState />}
      </>
    )
  } else {
    // The figures stay until a read replaces them, so a failure shows above them.
    body = (
      <Dashboard
        page={page}
        notice={
          <>
            {error && <ReadFailed error={error} kept />}
            {importing && <ImportProgress alone={false} />}
          </>
        }
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageBar />
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="@container mx-auto w-full max-w-275 px-10 pb-20">
          <header className="mb-5 flex min-h-7.5 items-center gap-3">
            <h1 className="truncate font-heading text-title font-semibold">{t('page.title')}</h1>
            <span className="flex-1" />
            {!unavailable && !empty && <SyncState />}
          </header>
          {body}
        </div>
      </div>
    </div>
  )
}

/**
 * The strip of sheet above the page, which drags the window. On macOS with the sidebar collapsed
 * it is a top bar's height, beside the traffic lights, and holds the sidebar toggle.
 */
function PageBar() {
  const cornered = useViewStore((s) => s.sidebarCollapsed) && isMac
  return (
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center',
        cornered ? 'h-top-bar pl-[calc(32px-var(--sheet-gap)+var(--traffic-lights))]' : 'h-9',
      )}
    >
      {cornered && <CornerControls className="-ml-1" />}
    </div>
  )
}

/** A read that failed: what failed, that the figures below stay, and Retry. */
function ReadFailed({ error, kept }: { error: string; kept: boolean }) {
  const { t } = useTranslation('usage')
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertTitle>{t('error.title')}</AlertTitle>
      <AlertDescription>{kept ? t('error.kept') : error}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={() => void loadUsagePage()}>
          {t('error.retry')}
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** The database cannot be read, even after its worker was started again. */
function Unavailable() {
  const { t } = useTranslation('usage')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setNote(null)
    try {
      const path = await exportDiagnostics()
      if (path) setNote(t('error.savedTo', { path }))
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertTitle>{t('error.title')}</AlertTitle>
      <AlertDescription>
        {t('error.unavailable')}
        {note && (
          <span data-selectable="" className="mt-1 block">
            {note}
          </span>
        )}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => void save()}>
          {t('error.export')}
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** When the logs were last read, and Sync now; or where the figures come from. */
function SyncState() {
  const { t } = useTranslation('usage')
  const fromComputer = useUsageStore((s) => s.status?.fromComputer ?? null)
  const synced = useUsageStore(
    (s) =>
      s.status?.logs.reduce<number | null>(
        (latest, log) =>
          log.syncedAt !== null && (latest === null || log.syncedAt > latest)
            ? log.syncedAt
            : latest,
        null,
      ) ?? null,
  )
  const reading = useUsageStore((s) => s.status?.scanning != null)
  const now = useNow()
  const refresh = useRefresh({ busy: reading })
  const [failed, setFailed] = useState<string | null>(null)
  if (fromComputer === null) return null
  if (!fromComputer) {
    return <span className="text-command text-tertiary">{t('page.record')}</span>
  }
  const scanning = refresh.phase === 'turning'
  return (
    <NoDrag className="gap-3">
      {failed && !scanning ? (
        <Tooltip>
          <TooltipTrigger render={<span role="alert" className="text-command text-danger" />}>
            {t('page.syncFailed')}
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{failed}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-command text-tertiary">
          {scanning
            ? t('page.syncing')
            : synced !== null
              ? t('page.synced', { ago: longAgo(synced, now) })
              : ''}
        </span>
      )}
      <Button
        variant="quiet"
        size="sm"
        aria-busy={scanning}
        disabled={scanning}
        className="-mr-2"
        onClick={() => {
          setFailed(null)
          void refresh.run(syncUsage).catch((e: unknown) => setFailed(errorMessage(e)))
        }}
      >
        <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
        {t('page.sync')}
      </Button>
    </NoDrag>
  )
}

/** A scan's progress: in place of the page on its first import, else above the figures. */
function ImportProgress({ alone }: { alone: boolean }) {
  const { t } = useTranslation('usage')
  const scanning = useUsageStore((s) => s.status?.scanning ?? null)
  const logs = useUsageStore((s) => s.status?.logs ?? null)
  if (!scanning) return null
  const share = scanning.bytes > 0 ? (scanning.doneBytes / scanning.bytes) * 100 : 0
  const found = (logs ?? []).filter((log) => log.found === true || log.rows > 0)
  const since = found.reduce<number | null>(
    (first, log) =>
      log.first !== null && (first === null || log.first < first) ? log.first : first,
    null,
  )
  const agents =
    found.length > 0
      ? new Intl.ListFormat(currentLocale()).format(found.map((log) => agentName(log.agentId)))
      : null
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-2.5 rounded-xl bg-card px-5 py-4.5 shadow-card',
        alone && 'mx-auto my-12 max-w-130',
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        <Spinner aria-hidden className="size-3 text-tertiary" />
        <span className="tabular-nums">
          {t('page.importing', { done: bytes(scanning.doneBytes), total: bytes(scanning.bytes) })}
        </span>
      </div>
      <Progress
        value={share}
        aria-label={t('page.syncing')}
        className="[&_[data-slot=progress-indicator]]:text-foreground"
      />
      {alone && (
        <p className="text-xs text-tertiary">
          {agents === null
            ? t('page.importingNote')
            : since === null
              ? t('page.importingAgents', { agents })
              : t('page.importingFrom', {
                  agents,
                  date: new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(
                    since,
                  ),
                })}
        </p>
      )}
    </div>
  )
}

function LoadingState() {
  const { t } = useTranslation('usage')
  return (
    <div aria-busy className="flex flex-col gap-4">
      <span role="status" className="sr-only">
        {t('page.loading')}
      </span>
      <Skeleton className="h-24 rounded-xl" />
      <div className={PANEL_ROW}>
        <Skeleton className="h-72.5 rounded-xl" />
        <Skeleton className="h-72.5 rounded-xl" />
      </div>
      <Skeleton className="h-57 rounded-xl" />
    </div>
  )
}

/** Nothing recorded yet: what will appear, and the offer to read the logs already there. */
function FirstRun() {
  const { t } = useTranslation('usage')
  const fromComputer = useSettingsStore((s) => s.settings.usage.fromComputer)
  return (
    <Empty className="py-18">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChartNoAxesColumnIcon />
        </EmptyMedia>
        <EmptyTitle>{t('empty.title')}</EmptyTitle>
        <EmptyDescription>
          {fromComputer ? t('empty.waiting') : t('empty.description')}
        </EmptyDescription>
      </EmptyHeader>
      {!fromComputer && (
        <EmptyContent>
          <Button
            size="sm"
            onClick={() =>
              void useSettingsStore.getState().update({ usage: { fromComputer: true } })
            }
          >
            {t('empty.fromComputer')}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

const NO_DAYS: ReadonlySet<number> = new Set()

/** The tighter segments the filters' row needs to fit on one line. */
const SEGMENT = 'px-2 text-command'
const MARK_SEGMENT = 'min-w-7 px-1.75 text-command'

/**
 * One row that every panel follows: what is counted on the left, when on the right, which wraps
 * under the left one. Before the first figures arrive, the agents are not known yet.
 */
function Filters({ page, used }: { page: PageData | null; used: ReadonlySet<number> }) {
  const { t } = useTranslation('usage')
  const filters = useUsageStore((s) => s.filters)
  const fromComputer = useUsageStore((s) => s.status?.fromComputer ?? false)
  const rangeText = useRangeText()
  const { agent, metric, scope } = filters
  const agents = page?.summary.agents ?? []
  // A chosen agent stays a choice once its usage is gone, as after clearing the record.
  const choices = agent === 'all' || agents.includes(agent) ? agents : [...agents, agent]
  const clockDay = useClock(dayOf)
  const today = page?.today ?? clockDay
  const custom = filters.range.kind === 'custom' ? filters.range : null
  return (
    <div
      role="toolbar"
      aria-label={t('page.range')}
      className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2.5"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <SegmentedControl
          aria-label={t('page.metric')}
          value={metric}
          onChange={(value) => setUsageFilters({ metric: value as Metric })}
          itemClassName={SEGMENT}
          segments={[
            { value: 'tokens', label: t('metrics.tokens') },
            { value: 'requests', label: t(`metrics.${metricKind('requests', scope)}`) },
            { value: 'cost', label: t('metrics.cost') },
          ]}
        />
        {/* With usage from one agent only, All is the only choice. */}
        {choices.length > 1 && (
          <SegmentedControl
            aria-label={t('page.agent')}
            value={agent}
            onChange={(value) => setUsageFilters({ agent: value })}
            itemClassName={MARK_SEGMENT}
            segments={[
              { value: 'all', label: t('page.allShort') },
              ...choices.map((id) => ({ value: id, label: <AgentSegment agentId={id} /> })),
            ]}
          />
        )}
        {fromComputer && (
          <SegmentedControl
            aria-label={t('page.scope')}
            value={scope}
            onChange={(next) => setUsageFilters({ scope: next })}
            itemClassName={SEGMENT}
            segments={[
              { value: 'computer', label: t('page.scopes.computer') },
              { value: 'kettu', label: t('page.scopes.kettu') },
            ]}
          />
        )}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <SegmentedControl
          aria-label={t('page.range')}
          value={filters.range.kind}
          onChange={(value) => setUsageFilters({ range: { kind: value as RangeKind } })}
          itemClassName={SEGMENT}
          segments={RANGE_KINDS.map((rangeKind) => ({
            value: rangeKind,
            label: t(`page.ranges.${rangeKind}`),
          }))}
        />
        <RangePicker
          value={custom}
          shown={page && { from: page.range.from, to: addDays(page.range.to, -1) }}
          label={custom ? rangeText(custom.from, addDays(custom.to, 1)) : null}
          today={today}
          firstDay={page?.firstDay ?? firstDayOfWeek(currentLocale())}
          first={page?.summary.first ?? null}
          used={used}
          onApply={(chosen) => setUsageFilters({ range: { kind: 'custom', ...chosen } })}
        />
      </div>
    </div>
  )
}

function Dashboard({ page, notice }: { page: PageData; notice: ReactNode }) {
  const { t } = useTranslation('usage')
  const filters = useUsageStore((s) => s.filters)
  const { summary, starts, range, today, firstDay } = page
  const agent = filters.agent
  const metric = filters.metric
  const scope = filters.scope
  const kind = metricKind(metric, scope)

  const allDays = useMemo(() => dayTotals(summary, starts, 'all'), [summary, starts])
  const days = useMemo(
    () => (agent === 'all' ? allDays : dayTotals(summary, starts, agent)),
    [agent, allDays, summary, starts],
  )
  const hours = useMemo<HourTotals | null>(
    () =>
      page.hours && {
        totals: dayTotals(page.hours.summary, page.hours.starts, agent),
        starts: page.hours.starts,
        zoned: clocksChange(page.hours.starts),
      },
    [page.hours, agent],
  )
  // The heatmap always ends today, so a new day reads the figures again, whether or not usage
  // arrives.
  const day = useClock(dayOf)
  useEffect(() => usageDayTurned(day), [day])
  const facts = useMemo(() => figures(days, range, metric, scope), [days, range, metric, scope])
  // The table by type and the cache share count tokens, whatever the metric.
  const tokenFacts = useMemo(() => figures(days, range), [days, range])
  const heat = heatmapRange(today, firstDay)
  const heatDays = useMemo(
    () => days.filter((d) => d.day >= heat.from && d.day < heat.to),
    [days, heat.from, heat.to],
  )
  const used = useMemo(
    () => new Set(allDays.filter((d) => d.total > 0).map((d) => d.day)),
    [allDays],
  )
  const rangeText = useRangeText()

  return (
    <>
      <Filters page={page} used={used} />
      <div className="flex flex-col gap-4">
        {notice}
        <div>
          <Figures
            facts={facts}
            hours={hours}
            kind={kind}
            metric={metric}
            scope={scope}
            rangeLabel={rangeText(range.from, range.to)}
          />
          {kind === 'cost' && (
            <EstimateNote asOf={summary.pricesAsOf} unpriced={unpricedTokens(facts)} />
          )}
        </div>

        <div className={PANEL_ROW}>
          <TrendCard days={days} hours={hours} page={page} metric={metric} scope={scope} />
          <PlanLimits used={summary.agents} />
        </div>

        <ActivityCard days={heatDays} page={page} metric={metric} scope={scope} />
        <PartsCard facts={tokenFacts} />

        <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
          <BreakdownCard
            title={t('models.title')}
            column={t('models.name')}
            valueLabel={t(`metrics.${kind}`)}
            kind={kind}
            rows={modelRows(summary, agent, metric, scope)}
            total={facts.total}
            nameOf={(row) => row.name ?? t('models.unknown')}
            mono
          />
          <BreakdownCard
            title={t('projects.title')}
            column={t('projects.name')}
            valueLabel={t(`metrics.${kind}`)}
            kind={kind}
            rows={projectRows(summary, agent, basename, metric, scope)}
            total={facts.total}
            nameOf={(row) => row.name ?? t('projects.none')}
          />
        </div>
      </div>
    </>
  )
}

/** An agent's segment: its mark, with its name in a tooltip and for screen readers. */
function AgentSegment({ agentId }: { agentId: AgentId }) {
  const name = agentName(agentId)
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center" />}>
        <AgentMark agent={agentId} size={14} />
        <span className="sr-only">{name}</span>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  )
}

/** "Sep 1 - Oct 22" for [from, to), or one day alone. */
function useRangeText(): (from: number, to: number) => string {
  const { i18n } = useTranslation('usage')
  return useCallback(
    (from: number, to: number) => {
      const last = addDays(to, -1)
      const sameYear = new Date(from).getFullYear() === new Date(last).getFullYear()
      const thisYear = new Date(last).getFullYear() === new Date().getFullYear()
      const format = new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
        ...(sameYear && thisYear ? {} : { year: 'numeric' }),
      })
      return last === from ? format.format(from) : format.formatRange(from, last)
    },
    [i18n.language],
  )
}

/** "3:00 PM – 4:00 PM" for an hour, with the time zones when `zoned`. */
function useHourText(zoned: boolean): (from: number, to: number) => string {
  const { t, i18n } = useTranslation('usage')
  return useCallback(
    (from: number, to: number) => {
      const time = new Intl.DateTimeFormat(i18n.language, {
        hour: 'numeric',
        minute: '2-digit',
        ...(zoned ? { timeZoneName: 'short' } : {}),
      })
      // Not formatRange, which adds both dates to the day's last hour.
      return t('trend.hour', { from: time.format(from), to: time.format(to) })
    },
    [t, i18n.language, zoned],
  )
}

/** "Tue, Oct 13", with the year when it is not this one. */
function dayText(day: number): string {
  const thisYear = new Date(day).getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(thisYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(day)
}

/** An amount in the metric, compact, and in words for screen readers. */
function useMetricText(kind: MetricKind) {
  const { t } = useTranslation('usage')
  return useMemo(() => {
    const short = (value: number) => (kind === 'cost' ? usd(value) : count(value))
    const unit = (value: number): string => {
      const text = count(value)
      if (kind === 'tokens') return t('units.tokens', { value: text })
      if (kind === 'cost') return usd(value)
      return kind === 'requests'
        ? t(value === 1 ? 'units.request' : 'units.requests', { value: text })
        : t(value === 1 ? 'units.turn' : 'units.turns', { value: text })
    }
    const sentence = (date: string, value: number): string =>
      kind === 'tokens'
        ? t('trend.label', { date, tokens: count(value) })
        : kind === 'cost'
          ? t('trend.labelCost', { date, cost: usd(value) })
          : t('trend.labelCount', { date, value: unit(value) })
    const part = (agent: AgentId, value: number): string =>
      t(
        kind === 'tokens'
          ? 'trend.agent'
          : kind === 'cost'
            ? 'trend.agentCost'
            : 'trend.agentCount',
        {
          agent: agentName(agent),
          tokens: count(value),
          cost: usd(value),
          value: unit(value),
        },
      )
    return { short, sentence, part }
  }, [kind, t])
}

/** A count, compact, with the exact value in its tooltip. */
function Count({ value, className }: { value: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('tabular-nums', className)} />}>
        {count(value)}
      </TooltipTrigger>
      <TooltipContent>{exactCount(value)}</TooltipContent>
    </Tooltip>
  )
}

/** A figure in the metric: a compact count, or US dollars. */
function FigureValue({ value, kind }: { value: number; kind: MetricKind }) {
  return kind === 'cost' ? (
    <span className="tabular-nums">{usd(value)}</span>
  ) : (
    <Count value={value} />
  )
}

/** The estimate's wording and the tokens no cost counts, under the Cost figures. */
function EstimateNote({ asOf, unpriced }: { asOf: string; unpriced: number | null }) {
  const { t, i18n } = useTranslation('usage')
  const [year, month, day] = asOf.split('-').map(Number)
  const date = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year!, month! - 1, day!))
  return (
    <div className="mt-2 flex flex-col gap-0.5 px-0.5 text-xs text-tertiary">
      <span>{t('figures.estimated', { date })}</span>
      {unpriced !== null && <span>{t('figures.unpriced', { tokens: tokens(unpriced) })}</span>}
    </div>
  )
}

/** Each figure's hairlines when two share a row, from `ledgerCell`. */
const LEDGER_LINES = {
  none: '',
  top: 'shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]',
  left: 'shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]',
  both: 'shadow-[inset_var(--hairline)_var(--hairline)_0_var(--border-subtle)]',
} as const

/**
 * The figures in one card divided into cells: in a row from 52 rem, else two to a row. The number
 * is compact, with the exact value in its tooltip.
 */
function Figures({
  facts,
  hours,
  kind,
  metric,
  scope,
  rangeLabel,
}: {
  facts: ReturnType<typeof figures>
  hours: HourTotals | null
  kind: MetricKind
  metric: Metric
  scope: UsageScope
  rangeLabel: string
}) {
  const { t } = useTranslation('usage')
  const hourText = useHourText(hours?.zoned ?? false)
  // Re-renders as an hour begins, not on every tick of the clock.
  const begun = useClock((now) => (hours ? hoursSoFar(hours.starts, now).to : 0))
  const hourly = useMemo(
    () => hours && figures(hours.totals, { from: hours.starts[0]!, to: begun }, metric, scope),
    [hours, begun, metric, scope],
  )
  const hourEnd = (start: number) => hours?.starts[hours.starts.indexOf(start) + 1] ?? start
  const none = <span className="text-tertiary">—</span>
  const shown = (value: number | null, priced = true): ReactNode =>
    value === null || (kind === 'cost' && !priced) ? (
      none
    ) : (
      <FigureValue value={value} kind={kind} />
    )
  const current = hourly ?? facts
  const average =
    current.average === null || kind === 'cost' ? current.average : Math.round(current.average)
  const peak = current.peak
  const totalLabel =
    kind === 'tokens'
      ? t('figures.total')
      : kind === 'cost'
        ? t('figures.cost')
        : t(`metrics.${kind}`)
  const perRequest = tokensPerRequest(current)
  const cells: { label: string; value: ReactNode; note: string }[] = []
  cells.push({
    label: totalLabel,
    value: shown(facts.activeDays > 0 ? facts.total : null, facts.priced),
    note: t('figures.days', { range: rangeLabel, count: facts.days }),
  })
  cells.push(
    hourly
      ? {
          label: t('figures.hourlyAverage'),
          value: shown(average, hourly.priced),
          note: t('figures.activeHours', { active: hourly.activeDays, count: hourly.days }),
        }
      : {
          label: t('figures.average'),
          value: shown(average, facts.priced),
          note: t('figures.active', { active: facts.activeDays, count: facts.days }),
        },
  )
  cells.push(
    hourly
      ? {
          label: t('figures.peakHour'),
          value: peak ? shown(peak.total) : none,
          note: peak ? hourText(peak.day, hourEnd(peak.day)) : t('figures.none'),
        }
      : {
          label: t('figures.peak'),
          value: peak ? shown(peak.total) : none,
          note: peak ? dayText(peak.day) : t('figures.none'),
        },
  )
  cells.push(
    kind === 'tokens'
      ? {
          label: t('figures.cacheShare'),
          value:
            facts.cacheShare !== null ? (
              <span className="tabular-nums">{percent(facts.cacheShare)}</span>
            ) : (
              none
            ),
          note: t('figures.cacheShareNote'),
        }
      : kind === 'cost'
        ? {
            label: t('figures.savedByCache'),
            value: current.activeDays > 0 ? shown(current.parts.cacheSaved, current.priced) : none,
            note: t('figures.cacheSavedNote'),
          }
        : {
            label: t('figures.tokensPerRequest'),
            value:
              perRequest !== null ? (
                <FigureValue value={Math.round(perRequest)} kind="tokens" />
              ) : (
                none
              ),
            note: t('figures.perRequestNote'),
          },
  )
  return (
    <div
      role="group"
      aria-label={t('figures.label')}
      className="grid grid-cols-2 rounded-xl bg-card shadow-card @min-[52rem]:grid-cols-4"
    >
      {cells.map((cell, i) => {
        const { top, left } = ledgerCell(i)
        return (
          <div
            key={cell.label}
            className={cn(
              'flex min-w-0 flex-col px-4.5 pt-3.5 pb-3.75',
              LEDGER_LINES[top ? (left ? 'both' : 'top') : left ? 'left' : 'none'],
              i === 0
                ? '@min-[52rem]:shadow-none'
                : '@min-[52rem]:shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]',
            )}
          >
            <span className="text-command font-medium text-secondary">{cell.label}</span>
            <span className="mt-1.5 font-heading text-figure font-medium tabular-nums lining-nums">
              {cell.value}
            </span>
            <span className="mt-0.75 text-xs text-pretty text-tertiary">{cell.note}</span>
          </div>
        )
      })}
    </div>
  )
}

const TREND_TITLE = {
  tokens: {
    hour: 'trend.hourly',
    day: 'trend.daily',
    week: 'trend.weekly',
    month: 'trend.monthly',
  },
  requests: {
    hour: 'trend.requestsHourly',
    day: 'trend.requestsDaily',
    week: 'trend.requestsWeekly',
    month: 'trend.requestsMonthly',
  },
  turns: {
    hour: 'trend.turnsHourly',
    day: 'trend.turnsDaily',
    week: 'trend.turnsWeekly',
    month: 'trend.turnsMonthly',
  },
  cost: {
    hour: 'trend.costHourly',
    day: 'trend.costDaily',
    week: 'trend.costWeekly',
    month: 'trend.costMonthly',
  },
} as const satisfies Record<MetricKind, Record<'hour' | 'day' | 'week' | 'month', string>>
/** Hours are labelled every 1, 2, 3, 4, 6 or 12, so the labels fall on the same times each day. */
const HOUR_STEPS = [1, 2, 3, 4, 6, 12]
/** A placeholder waits this long, so a quick answer shows no flash. */
const PLACEHOLDER_DELAY = 200

/** Whether `waiting` has held for longer than `PLACEHOLDER_DELAY`. */
function useLate(waiting: boolean): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setLate(true), PLACEHOLDER_DELAY)
    return () => {
      clearTimeout(timer)
      setLate(false)
    }
  }, [waiting])
  return waiting && late
}

function TrendCard({
  days,
  hours,
  page,
  metric,
  scope,
}: {
  days: DayTotal[]
  hours: HourTotals | null
  page: PageData
  metric: Metric
  scope: UsageScope
}) {
  const { t, i18n } = useTranslation('usage')
  const rangeText = useRangeText()
  const hourText = useHourText(hours?.zoned ?? false)
  const kind = metricKind(metric, scope)
  const text = useMetricText(kind)
  // Figures for another range or source are on their way.
  const late = useLate(
    useUsageStore(
      (s) =>
        s.loading &&
        !!s.page &&
        (s.page.filters.range !== s.filters.range || s.page.filters.scope !== s.filters.scope),
    ),
  )
  const { unit, bars } = useMemo(
    () =>
      hours
        ? { unit: 'hour' as const, bars: hourBars(hours.totals, hours.starts, metric, scope) }
        : trend(days, page.range, page.firstDay, metric, scope),
    [hours, days, page.range, page.firstDay, metric, scope],
  )
  const series = useMemo(() => seriesOf(bars, AGENT_IDS), [bars])
  // What the legend hides holds until any filter changes, even back to an earlier value: the agent
  // at once, the range or source once its figures arrive, so the chart still drawn while they load
  // keeps its series and scale.
  const agentGeneration = useUsageStore((s) => s.generations.agent)
  const drawn = useMemo(
    () => ({ agent: agentGeneration, figures: page.generation }),
    [agentGeneration, page.generation],
  )
  const [legend, setLegend] = useState<LegendChoice>({ ...drawn, hidden: NO_SERIES })
  const hidden = legendHides(legend, drawn)
  const shown = useMemo(() => shownSeries(series, hidden), [series, hidden])
  const toggle = useCallback(
    (chosen: AgentId[]) => setLegend({ ...drawn, hidden: legendHidden(series, chosen, hidden) }),
    [drawn, series, hidden],
  )
  const totals = useMemo(() => shownTotals(bars, shown), [bars, shown])
  const max = Math.max(0, ...totals)
  // Re-renders as an hour begins; a range of days never does.
  const future = useClock((now) => (hours ? bars.filter((bar) => bar.from > now).length : 0))
  const [chosen, setChosen] = useState<number | null>(null)
  const at = chosen !== null && chosen < bars.length - future ? chosen : null
  const index = at ?? busiest(totals)
  const bar = index === null ? null : bars[index]!
  const title = t(TREND_TITLE[kind][unit])
  const describe = (bar: TrendBar) =>
    unit === 'hour'
      ? hourText(bar.from, bar.to)
      : unit === 'day'
        ? dayText(bar.from)
        : unit === 'month' && wholeMonth(bar)
          ? new Intl.DateTimeFormat(i18n.language, { month: 'short', year: 'numeric' }).format(
              bar.from,
            )
          : rangeText(bar.from, bar.to)
  const froms = useMemo(() => bars.map((bar) => bar.from), [bars])
  const axisText = useMemo(() => {
    if (unit === 'hour') {
      const time = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' })
      return (i: number) => time.format(froms[i]!)
    }
    const date: Intl.DateTimeFormatOptions =
      unit === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' }
    const plain = new Intl.DateTimeFormat(i18n.language, date)
    const dated = new Intl.DateTimeFormat(i18n.language, { ...date, year: 'numeric' })
    return (i: number, previous: number | null) =>
      (namesYear(froms, i, previous) ? dated : plain).format(froms[i]!)
  }, [unit, froms, i18n.language])
  const pickHours = useMemo(
    () => (unit === 'hour' ? (step: number) => hourLabels(froms, step) : undefined),
    [unit, froms],
  )
  const spoken =
    bar &&
    [
      text.sentence(describe(bar), totals[index!]!),
      ...(series.length > 1
        ? shown.filter((id) => bar.byAgent[id]).map((id) => text.part(id, bar.byAgent[id]!))
        : []),
    ].join(' ')
  return (
    <Panel>
      <PanelHead
        title={title}
        aside={
          bar &&
          !late && (
            <Readout
              label={describe(bar)}
              value={totals[index!]! > 0 ? text.short(totals[index!]!) : '—'}
              spoken={spoken}
            />
          )
        }
      />
      <div className="flex flex-1 flex-col">
        {/* The scale's top, and the legend with each agent's part of the bar the header names. */}
        <div className="-mt-1.5 mb-2 flex min-h-6 flex-wrap items-baseline gap-x-4 gap-y-1">
          <span aria-hidden className="text-meta leading-6 text-tertiary tabular-nums">
            {!late && max > 0 && text.short(max)}
          </span>
          {!late && series.length > 1 && (
            <TrendLegend
              bars={bars}
              index={index}
              series={series}
              shown={shown}
              label={t('trend.legend')}
              keepOne={t('trend.keepOne')}
              formatValue={text.short}
              onChange={toggle}
            />
          )}
        </div>
        {late ? (
          <Skeleton className="min-h-49 flex-1" />
        ) : max === 0 ? (
          <p className="flex min-h-49 flex-1 items-center justify-center font-serif text-prose text-tertiary shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-default)]">
            {kind === 'cost' && days.some((day) => day.total > 0) ? t('noCost') : t('noUsage')}
          </p>
        ) : (
          <TrendChart
            bars={bars}
            series={shown}
            max={max}
            shown={index}
            chosen={at}
            label={title}
            future={future}
            onChoose={setChosen}
          />
        )}
        {late || max === 0 ? (
          <span className="mt-1.5 h-5" />
        ) : (
          <TrendAxis
            count={bars.length}
            anchor={unit === 'hour' ? 'start' : 'end'}
            steps={unit === 'hour' ? HOUR_STEPS : undefined}
            pick={pickHours}
            text={axisText}
          />
        )}
      </div>
    </Panel>
  )
}

function ActivityCard({
  days,
  page,
  metric,
  scope,
}: {
  days: DayTotal[]
  page: PageData
  metric: Metric
  scope: UsageScope
}) {
  const { t, i18n } = useTranslation('usage')
  const text = useMetricText(metricKind(metric, scope))
  const starts = useMemo(() => days.map((d) => d.day), [days])
  const values = useMemo(
    () => days.map((d) => metricValue(d.parts, metric, scope) ?? 0),
    [days, metric, scope],
  )
  const [shown, setShown] = useState<number | null>(null)
  const monthLabel = useCallback(
    (day: number) => new Intl.DateTimeFormat(i18n.language, { month: 'short' }).format(day),
    [i18n.language],
  )
  const weekdayLabel = useCallback(
    (day: number) => new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(day),
    [i18n.language],
  )
  const outside = starts.some((d) => d < page.range.from || d >= page.range.to)
  const day = shown === null ? undefined : starts[shown]
  const value = shown === null ? 0 : values[shown]!
  return (
    <Panel>
      <PanelHead
        title={t('activity.title')}
        caption={<span className="ml-0.5 text-xs text-tertiary">{t('activity.weeks')}</span>}
        aside={
          day !== undefined && (
            <Readout
              label={dayText(day)}
              value={value > 0 ? text.short(value) : '—'}
              spoken={text.sentence(dayText(day), value)}
            />
          )
        }
      />
      <Heatmap
        days={starts}
        values={values}
        range={page.range}
        label={t('activity.label')}
        monthLabel={monthLabel}
        weekdayLabel={weekdayLabel}
        onShow={setShown}
      />
      <div className="mt-3 flex items-center gap-2 text-meta text-tertiary">
        {outside && <span>{t('activity.outside')}</span>}
        <span className="flex-1" />
        <HeatLegend less={t('activity.less')} more={t('activity.more')} />
      </div>
    </Panel>
  )
}

/** The table's rows: input and output, reasoning where reported, then the cache's two parts. */
const PARTS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'] as const

function PartsCard({ facts }: { facts: ReturnType<typeof figures> }) {
  const { t } = useTranslation('usage')
  const rows = PARTS.filter((part) => part !== 'reasoning' || facts.parts.reasoning > 0)
  const some = facts.total > 0
  return (
    <Panel>
      <PanelHead title={t('parts.title')} />
      <table className="w-full text-small tabular-nums">
        <thead className="text-xs text-tertiary">
          <tr className="h-6.5">
            <th className="text-left font-medium">{t('parts.type')}</th>
            <th className="text-right font-medium">{t('parts.tokens')}</th>
            <th className="w-18 pl-4 text-right font-medium">{t('parts.share')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((part) => (
            <tr key={part} className="h-8.5 border-t border-subtle">
              <td>{t(`parts.${part}`)}</td>
              <td className="pl-4 text-right">{some ? exactCount(facts.parts[part]) : '—'}</td>
              <td className="pl-4 text-right text-secondary">
                {some ? percent(facts.parts[part] / facts.total) : '—'}
              </td>
            </tr>
          ))}
          <tr className="h-8.5 border-t border-default font-semibold">
            <td>{t('parts.total')}</td>
            <td className="pl-4 text-right">{some ? exactCount(facts.total) : '—'}</td>
            <td className="pl-4 text-right">{some ? percent(1) : '—'}</td>
          </tr>
        </tbody>
      </table>
    </Panel>
  )
}

function BreakdownCard({
  title,
  column,
  valueLabel,
  kind,
  rows,
  total,
  nameOf,
  mono = false,
}: {
  title: string
  column: string
  valueLabel: string
  kind: MetricKind
  rows: BreakdownRow[]
  total: number
  nameOf: (row: BreakdownRow) => string
  mono?: boolean
}) {
  const { t } = useTranslation('usage')
  return (
    <Panel>
      <PanelHead title={title} />
      <table className="w-full table-fixed text-small tabular-nums">
        <thead className="text-xs text-tertiary">
          <tr className="h-6.5">
            <th className="text-left font-medium">{column}</th>
            <th className="w-36 text-right font-medium">{valueLabel}</th>
            <th className="w-28 pl-4 text-right font-medium">{t('parts.share')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="h-8.5 border-t border-subtle">
              <td colSpan={3} className="text-tertiary">
                {t('noUsage')}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const share = row.value !== null && total > 0 ? row.value / total : null
              return (
                <tr key={row.key} className="h-8.5 border-t border-subtle">
                  <td className="pr-4">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            className={cn(
                              'block truncate',
                              mono && row.name && 'font-mono text-command',
                            )}
                          />
                        }
                      >
                        {nameOf(row)}
                      </TooltipTrigger>
                      <TooltipContent>{row.path ?? nameOf(row)}</TooltipContent>
                    </Tooltip>
                  </td>
                  <td className={cn('text-right', row.value === null && 'text-secondary')}>
                    {row.value === null
                      ? t('noPrice')
                      : kind === 'cost'
                        ? usd(row.value)
                        : exactCount(row.value)}
                  </td>
                  <td className="pl-4">
                    <span className="flex items-center justify-end gap-2.5 text-secondary">
                      <span
                        aria-hidden
                        className="h-1 w-11 shrink-0 overflow-hidden rounded-full bg-track"
                      >
                        <span
                          className="block h-full rounded-full bg-(--text-secondary)"
                          style={{ width: `${(share ?? 0) * 100}%` }}
                        />
                      </span>
                      <span className="min-w-9.5 text-right">
                        {share !== null ? percent(share) : '—'}
                      </span>
                    </span>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </Panel>
  )
}
