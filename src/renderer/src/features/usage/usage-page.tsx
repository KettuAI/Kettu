import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChartPieIcon, ChevronDownIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { partsTotal, type TokenParts, type UsageScope } from '@shared/usage'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { exportDiagnostics } from '@renderer/app/actions'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
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
import { CornerControls } from '@renderer/features/shell/top-bar'
import { bytes, count, longAgo, percent, tokens, usd } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { currentLocale } from '@renderer/lib/i18n'
import { hasBand, isMac } from '@renderer/lib/platform'
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
import { Activity } from './activity'
import { Breakdown } from './breakdown'
import {
  addDays,
  clocksChange,
  dayOf,
  dayTotals,
  figures,
  firstDayOfWeek,
  fromCache,
  hoursSoFar,
  ledgerCell,
  metricKind,
  RANGE_KINDS,
  tokenParts,
  tokensPerRequest,
  unpricedTokens,
  type Metric,
  type MetricKind,
  type RangeKind,
} from './model'
import { OverTime, type HourTotals } from './over-time'
import { Panel, PanelTitle } from './panel'
import { PlanLimits } from './plan-limits'
import { RangePicker } from './range-picker'
import { Count, FigureValue } from './count'
import { dayText, useHourText, useRangeText } from './text'

/** A scan with less than this to read is over before its progress is worth showing. */
const IMPORT_SHOWN = 50_000_000

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
  const title = <h1 className="truncate font-display text-title font-bold">{t('page.title')}</h1>
  let body: ReactNode
  if (unavailable) {
    body = (
      <>
        {title}
        <Unavailable />
      </>
    )
  } else if (empty) {
    // A first import fills the page as it goes; until then its progress stands in for it.
    body = (
      <>
        {title}
        {importing ? <ImportProgress alone /> : <FirstRun />}
      </>
    )
  } else if (!page) {
    body = (
      <>
        <Header title={title} page={null} used={NO_DAYS} />
        {error ? <ReadFailed error={error} kept={false} /> : <LoadingState />}
      </>
    )
  } else {
    // The figures stay until a read replaces them, so a failure shows above them.
    body = (
      <Dashboard
        title={title}
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
        <div className="px-9 pb-10">
          <div className="@container mx-auto flex w-full max-w-270 flex-col gap-4.5">{body}</div>
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
  const cornered = useViewStore((s) => s.sidebarCollapsed) && !hasBand
  return (
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center',
        cornered ? 'h-top-bar pl-(--corner-inset)' : 'h-8',
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

/** When the logs were last read, and Sync; or where the figures come from. */
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
    return <span className="text-hint text-tertiary">{t('page.record')}</span>
  }
  const scanning = refresh.phase === 'turning'
  return (
    <div className="flex items-center gap-2">
      {failed && !scanning ? (
        <Tooltip>
          <TooltipTrigger render={<span role="alert" className="text-hint text-danger" />}>
            {t('page.syncFailed')}
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{failed}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="flex items-center gap-1.5 text-hint text-tertiary">
          {!scanning && synced !== null && (
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
          )}
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
        className="h-7 gap-1.5 px-2 text-hint text-secondary"
        onClick={() => {
          setFailed(null)
          void refresh.run(syncUsage).catch((e: unknown) => setFailed(errorMessage(e)))
        }}
      >
        <RefreshIcon phase={refresh.phase} className="size-3.5" />
        {t('page.syncAction')}
      </Button>
    </div>
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
        alone && 'mx-auto my-12 w-full max-w-130',
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
    <div aria-busy className="flex flex-col gap-4.5">
      <span role="status" className="sr-only">
        {t('page.loading')}
      </span>
      <div className="grid gap-4.5 @min-[45rem]:grid-cols-2">
        <Skeleton className="h-50 rounded-xl" />
        <Skeleton className="h-50 rounded-xl" />
      </div>
      <Skeleton className="h-45 rounded-xl" />
      <Skeleton className="h-70 rounded-xl" />
    </div>
  )
}

/** Nothing recorded yet: what will appear, and the offer to read the logs already there. */
function FirstRun() {
  const { t } = useTranslation('usage')
  const onHost = useHostContext()
  const fromComputer = useSettingsStore((s) => s.settings.usage.fromComputer)
  return (
    <Empty className="py-18">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChartPieIcon />
        </EmptyMedia>
        <EmptyTitle>{t('empty.title')}</EmptyTitle>
        <EmptyDescription>
          {fromComputer ? t('empty.waiting') : t('empty.description', onHost)}
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
            {t('empty.fromComputer', onHost)}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}

const NO_DAYS: ReadonlySet<number> = new Set()

/** A filter's button: what it filters, then the current choice, which opens the choices. */
const FILTER_BUTTON =
  'h-7.5 gap-1.5 pr-2 pl-2.5 text-hint font-normal text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] hover:text-primary aria-expanded:text-primary'

function FilterMenu<T extends string>({
  label,
  value,
  current,
  choices,
  onChange,
}: {
  label: string
  value: T
  /** The current choice as the button shows it. */
  current: ReactNode
  choices: readonly { value: T; label: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className={FILTER_BUTTON} />}>
        <span className="text-tertiary">{label}</span>
        {current}
        <ChevronDownIcon aria-hidden strokeWidth={1.75} className="size-3 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="max-w-72 min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const picked = choices.find((choice) => choice.value === next)
            if (picked) onChange(picked.value)
          }}
        >
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} closeOnClick>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** An agent's mark and name, as a filter shows it. */
function AgentChoice({ agentId }: { agentId: AgentId }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AgentMark agent={agentId} size={14} className="size-3.5" />
      <span className="truncate">{agentName(agentId)}</span>
    </span>
  )
}

/**
 * The title with the range beside it, then what is counted: the agents and the source, and the
 * sync state at the end. Before the first figures arrive, the agents are not known yet.
 */
function Header({
  title,
  page,
  used,
}: {
  title: ReactNode
  page: PageData | null
  used: ReadonlySet<number>
}) {
  const { t } = useTranslation('usage')
  const onHost = useHostContext()
  const filters = useUsageStore((s) => s.filters)
  // null until the status arrives, when the sync state shows nothing either.
  const fromComputer = useUsageStore((s) => s.status?.fromComputer ?? null)
  const rangeText = useRangeText()
  const { agent, scope } = filters
  const agents = page?.summary.agents ?? []
  // A chosen agent stays a choice once its usage is gone, as after clearing the record.
  const choices = agent === 'all' || agents.includes(agent) ? agents : [...agents, agent]
  const filterRow = choices.length > 1 || fromComputer !== null
  const clockDay = useClock(dayOf)
  const today = page?.today ?? clockDay
  const custom = filters.range.kind === 'custom' ? filters.range : null
  // This computer is "This Mac" on a Mac, and the host's name on another host or in a browser.
  const computer = t(
    'page.scopes.computer',
    onHost.context ? onHost : isMac ? { context: 'mac' } : {},
  )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-0 flex-auto">{title}</div>
        <div className="flex items-center gap-2.5">
          <SegmentedControl
            aria-label={t('page.range')}
            value={filters.range.kind}
            onChange={(value) => setUsageFilters({ range: { kind: value as RangeKind } })}
            segments={RANGE_KINDS.map((rangeKind) => ({
              value: rangeKind,
              label: (
                <>
                  <span aria-hidden>{t(`page.rangesShort.${rangeKind}`)}</span>
                  <span className="sr-only">{t(`page.ranges.${rangeKind}`)}</span>
                </>
              ),
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
      {filterRow && (
        <div className="flex flex-wrap items-center gap-2">
          {/* With usage from one agent only, All is the only choice. */}
          {choices.length > 1 && (
            <FilterMenu
              label={t('page.agents')}
              value={agent}
              current={agent === 'all' ? t('page.allShort') : <AgentChoice agentId={agent} />}
              choices={[
                { value: 'all', label: t('page.allShort') },
                ...choices.map((id) => ({ value: id, label: <AgentChoice agentId={id} /> })),
              ]}
              onChange={(next) => setUsageFilters({ agent: next })}
            />
          )}
          {fromComputer && (
            <FilterMenu<UsageScope>
              label={t('page.scope')}
              value={scope}
              current={scope === 'computer' ? computer : t('page.scopes.kettu')}
              choices={[
                { value: 'computer', label: computer },
                { value: 'kettu', label: t('page.scopes.kettu') },
              ]}
              onChange={(next) => setUsageFilters({ scope: next })}
            />
          )}
          <span className="flex-1" />
          <SyncState />
        </div>
      )}
    </div>
  )
}

function Dashboard({
  title,
  page,
  notice,
}: {
  title: ReactNode
  page: PageData
  notice: ReactNode
}) {
  const filters = useUsageStore((s) => s.filters)
  const { summary, starts, range } = page
  const { agent, metric, scope } = filters
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
  // Where the tokens come from counts tokens, whatever the metric.
  const tokenFacts = useMemo(() => figures(days, range), [days, range])
  const requestFacts = useMemo(() => figures(days, range, 'requests', scope), [days, range, scope])
  const used = useMemo(
    () => new Set(allDays.filter((d) => d.total > 0).map((d) => d.day)),
    [allDays],
  )
  const rangeText = useRangeText()

  return (
    <>
      <Header title={title} page={page} used={used} />
      {notice}
      <div className="flex flex-col gap-2">
        <div className="grid gap-4.5 @min-[45rem]:grid-cols-2">
          <Figures
            facts={facts}
            requestFacts={requestFacts}
            hours={hours}
            kind={kind}
            metric={metric}
            scope={scope}
            rangeLabel={rangeText(range.from, range.to)}
          />
          <PlanLimits used={summary.agents} />
        </div>
        {kind === 'cost' && (
          <EstimateNote asOf={summary.pricesAsOf} unpriced={unpricedTokens(facts)} />
        )}
      </div>
      <TokenSources
        parts={tokenFacts.parts}
        saved={kind === 'cost' && facts.priced ? facts.parts.cacheSaved : null}
      />
      <OverTime days={days} hours={hours} page={page} metric={metric} scope={scope} />
      <Activity days={days} page={page} metric={metric} scope={scope} />
      <Breakdown
        summary={summary}
        agent={agent}
        metric={metric}
        scope={scope}
        kind={kind}
        total={facts.total}
      />
    </>
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
    <div className="flex flex-col gap-0.5 px-0.5 text-xs text-tertiary">
      <span>{t('figures.estimated', { date })}</span>
      {unpriced !== null && <span>{t('figures.unpriced', { tokens: tokens(unpriced) })}</span>}
    </div>
  )
}

/** Each figure's lines when two share a row, from `ledgerCell`. */
const LEDGER_LINES = {
  none: '',
  top: 'shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]',
  left: 'shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]',
  both: 'shadow-[inset_var(--hairline)_var(--hairline)_0_var(--border-subtle)]',
} as const

/**
 * Four figures in one card, two to a row: the range's total, its average, its busiest day and
 * its requests, or by the hour for one day. The number is compact, with the exact value in its
 * tooltip.
 */
function Figures({
  facts,
  requestFacts,
  hours,
  kind,
  metric,
  scope,
  rangeLabel,
}: {
  facts: ReturnType<typeof figures>
  /** The range in requests, or turns under Kettu only, whatever the metric. */
  requestFacts: ReturnType<typeof figures>
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
  const hourlyRequests = useMemo(
    () => hours && figures(hours.totals, { from: hours.starts[0]!, to: begun }, 'requests', scope),
    [hours, begun, scope],
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
  const requestKind = metricKind('requests', scope)
  const totalLabel = {
    tokens: t('figures.total'),
    cost: t('figures.cost'),
    requests: t('figures.totalRequests'),
    turns: t('figures.totalTurns'),
  }[kind]
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
  if (kind === 'requests' || kind === 'turns') {
    // Requests lead the card already, so the last figure is the tokens they took.
    const perRequest = tokensPerRequest(facts)
    cells.push({
      label: t('figures.total'),
      value: facts.activeDays > 0 ? <Count value={facts.tokens} /> : none,
      note:
        perRequest === null
          ? t('figures.none')
          : t(kind === 'turns' ? 'figures.perTurn' : 'figures.perRequest', {
              value: count(Math.round(perRequest)),
            }),
    })
  } else {
    const perPeriod = (hourlyRequests ?? requestFacts).average
    cells.push({
      label: t(`metrics.${requestKind}`),
      value: requestFacts.total > 0 ? <Count value={requestFacts.total} /> : none,
      note:
        perPeriod === null || requestFacts.total <= 0
          ? t('figures.none')
          : t(
              hourlyRequests
                ? requestKind === 'turns'
                  ? 'figures.turnsPerHour'
                  : 'figures.requestsPerHour'
                : requestKind === 'turns'
                  ? 'figures.turnsPerDay'
                  : 'figures.requestsPerDay',
              { value: count(Math.round(perPeriod)) },
            ),
    })
  }
  return (
    <div
      role="group"
      aria-label={t('figures.label')}
      className="grid min-w-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-xl bg-card shadow-card"
    >
      {cells.map((cell, i) => {
        const { top, left } = ledgerCell(i)
        return (
          <div
            key={i}
            className={cn(
              'flex min-w-0 flex-col gap-0.75 px-4.5 py-3.5',
              LEDGER_LINES[top ? (left ? 'both' : 'top') : left ? 'left' : 'none'],
            )}
          >
            <span className="text-hint text-tertiary">{cell.label}</span>
            <span className="font-display text-figure font-bold tracking-[-0.02em] text-primary tabular-nums lining-nums">
              {cell.value}
            </span>
            <span className="text-small text-pretty text-tertiary">{cell.note}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * How much of the range's tokens the prompt cache served, and what the rest were made of. Always
 * in tokens, whatever the metric; under Cost, what the cache saved.
 */
function TokenSources({ parts, saved }: { parts: TokenParts; saved: number | null }) {
  const { t } = useTranslation('usage')
  const cache = fromCache(parts)
  const rest = tokenParts(parts, partsTotal(parts)).filter(({ part }) => part !== 'cacheRead')
  const line =
    cache.share === null
      ? t('noUsage')
      : cache.read === 0
        ? t('cache.none')
        : t('cache.perHundred', { count: cache.perHundred! })
  const restTitle =
    cache.share === null
      ? t('cache.otherNone')
      : cache.read === 0
        ? t('cache.allTokens', { tokens: count(cache.other) })
        : t('cache.other', { share: percent(1 - cache.share), tokens: count(cache.other) })
  return (
    <Panel>
      <PanelTitle className="mb-3.5">{t('cache.title')}</PanelTitle>
      <div className="grid items-start gap-7 @min-[35rem]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-hint text-tertiary">{t('cache.read')}</span>
          <span className="font-display text-[30px] leading-9 font-bold tracking-[-0.02em] text-primary tabular-nums lining-nums">
            {cache.share === null ? (
              <span className="text-tertiary">—</span>
            ) : (
              <>
                <Count value={cache.read} />{' '}
                <span className="text-[15px] font-medium tracking-normal text-success">
                  {percent(cache.share)}
                </span>
              </>
            )}
          </span>
          <p className="text-control leading-normal text-secondary">
            {line}
            {saved !== null && saved > 0 && (
              <span className="block">{t('cache.saved', { cost: usd(saved) })}</span>
            )}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 pt-3.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)] @min-[35rem]:pt-0 @min-[35rem]:pl-6 @min-[35rem]:shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]">
          <span className="mb-0.5 text-hint text-tertiary">{restTitle}</span>
          {rest.map(({ part, tokens: value }) => (
            <div key={part} className="flex justify-between gap-3 text-control">
              <span className="truncate text-tertiary">{t(`parts.${part}`)}</span>
              {cache.share === null ? (
                <span className="text-tertiary">—</span>
              ) : (
                <Count value={value} className="text-primary" />
              )}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}
