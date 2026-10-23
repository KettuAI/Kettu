import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChartNoAxesColumnIcon, CircleAlertIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
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
import { LimitsPart } from '@renderer/features/session/composer/usage'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { basename, bytes, exactCount, longAgo, percent, tokens } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useClock, useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  loadUsagePage,
  refreshLimits,
  setUsageFilters,
  syncUsage,
  usageDayTurned,
  usagePageShown,
  useUsageStore,
  type UsageFilters,
  type UsagePage as PageData,
} from '@renderer/stores/usage'
import { HeatLegend, Heatmap, TrendAxis, TrendChart, TrendLegend } from './charts'
import {
  addDays,
  AGENT_FILL,
  busiest,
  clocksChange,
  dayOf,
  dayTotals,
  figures,
  heatmapRange,
  hourBars,
  hoursSoFar,
  legendHidden,
  modelRows,
  monthStartOf,
  projectRows,
  RANGE_KINDS,
  seriesOf,
  shownSeries,
  shownTotals,
  trend,
  type BreakdownRow,
  type DayTotal,
  type RangeKind,
  type TrendBar,
} from './model'
import { RangePicker } from './range-picker'

/** A one-day range's totals per hour, and the hour starts they were summed over. */
interface HourTotals {
  totals: DayTotal[]
  starts: number[]
  /** The clocks change that day, so its hours name their time zones. */
  zoned: boolean
}

/** The usage page: a dashboard of the tokens the agents used, for a chosen agent and range. */
export default function UsagePage() {
  const { t } = useTranslation('usage')
  const unavailable = useUsageStore((s) => s.status?.unavailable ?? false)
  const scanning = useUsageStore((s) => s.status?.scanning != null)
  const page = useUsageStore((s) => s.page)
  const error = useUsageStore((s) => s.error)
  // OverBench only can be empty while the logs are not; the filters must stay to switch back.
  const narrowed = useUsageStore((s) => s.filters.scope === 'overbench' && !!s.status?.fromComputer)

  useEffect(() => {
    usagePageShown(true)
    return () => usagePageShown(false)
  }, [])

  let body: ReactNode
  if (unavailable) {
    body = <Unavailable />
  } else if (error && !page) {
    body = (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>{t('error.title')}</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="compact" onClick={() => void loadUsagePage()}>
            {t('error.retry')}
          </Button>
        </AlertAction>
      </Alert>
    )
  } else if (!page) {
    body = <LoadingState />
  } else if (page.summary.first === null && !scanning && !narrowed) {
    body = <FirstRun />
  } else {
    body = <Dashboard page={page} />
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <h1 className="truncate text-ui font-medium">{t('page.title')}</h1>
        <span className="flex-1" />
        <SyncState />
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-2 pb-9 [scrollbar-gutter:stable]">
        <div className="@container mx-auto flex max-w-240 flex-col gap-4">
          <Importing />
          {body}
        </div>
      </div>
    </div>
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
    <Alert variant="destructive">
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
        <Button variant="outline" size="compact" disabled={saving} onClick={() => void save()}>
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
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (fromComputer === null) return null
  if (!fromComputer) {
    return <span className="text-xs text-tertiary">{t('page.record')}</span>
  }
  const scanning = busy || reading
  return (
    <NoDrag className="gap-2">
      {failed && !scanning ? (
        <Tooltip>
          <TooltipTrigger render={<span role="alert" className="text-xs text-danger" />}>
            {t('page.syncFailed')}
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{failed}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-tertiary">
          {scanning
            ? t('page.syncing')
            : synced !== null
              ? t('page.synced', { ago: longAgo(synced, now) })
              : ''}
        </span>
      )}
      <Button
        variant="quiet"
        size="compact"
        disabled={scanning}
        onClick={() => {
          setBusy(true)
          setFailed(null)
          void syncUsage()
            .catch((e: unknown) => setFailed(errorMessage(e)))
            .finally(() => setBusy(false))
        }}
      >
        {scanning ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RefreshCwIcon data-icon="inline-start" />
        )}
        {t('page.sync')}
      </Button>
    </NoDrag>
  )
}

/** The first import's progress, above the figures it fills. */
function Importing() {
  const { t } = useTranslation('usage')
  const scanning = useUsageStore((s) => s.status?.scanning ?? null)
  // A scan with nothing new to read is over before it is worth showing.
  if (!scanning || scanning.bytes < 50_000_000) return null
  const share = scanning.bytes > 0 ? (scanning.doneBytes / scanning.bytes) * 100 : 0
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-tertiary tabular-nums">
        {t('page.importing', { done: bytes(scanning.doneBytes), total: bytes(scanning.bytes) })}
      </span>
      <Progress value={share} aria-label={t('page.syncing')} />
    </div>
  )
}

function LoadingState() {
  return (
    <div aria-busy className="flex flex-col gap-4">
      <Skeleton className="h-control w-2/3" />
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  )
}

/** Nothing recorded yet: what will appear, and the offer to read the logs already there. */
function FirstRun() {
  const { t } = useTranslation('usage')
  const fromComputer = useSettingsStore((s) => s.settings.usage.fromComputer)
  return (
    <Empty className="py-24">
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
            variant="outline"
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

function Dashboard({ page }: { page: PageData }) {
  const { t } = useTranslation('usage')
  const filters = useUsageStore((s) => s.filters)
  const fromComputer = useUsageStore((s) => s.status?.fromComputer ?? false)
  const { summary, starts, range, today, firstDay } = page
  const agent = filters.agent

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
  // A chosen agent stays a choice once its usage is gone, as after clearing the record.
  const choices =
    agent === 'all' || summary.agents.includes(agent) ? summary.agents : [...summary.agents, agent]
  const facts = useMemo(() => figures(days, range), [days, range])
  const heat = heatmapRange(today, firstDay)
  const heatDays = useMemo(
    () => days.filter((d) => d.day >= heat.from && d.day < heat.to),
    [days, heat.from, heat.to],
  )
  const used = useMemo(
    () => new Set(allDays.filter((d) => d.total > 0).map((d) => d.day)),
    [allDays],
  )
  const custom = filters.range.kind === 'custom' ? filters.range : null
  const rangeText = useRangeText()

  return (
    <>
      {/* What is counted on the left, and when on the right; the right wraps under the left. */}
      <div
        role="toolbar"
        aria-label={t('page.range')}
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* With usage from one agent only, All is the only choice. */}
          {choices.length > 1 && (
            <SegmentedControl
              aria-label={t('page.agent')}
              value={agent}
              onChange={(value) => setUsageFilters({ agent: value })}
              segments={[
                { value: 'all', label: t('page.allShort') },
                ...choices.map((id) => ({ value: id, label: <AgentSegment agentId={id} /> })),
              ]}
            />
          )}
          {fromComputer && (
            <SegmentedControl
              aria-label={t('page.scope')}
              value={filters.scope}
              onChange={(scope) => setUsageFilters({ scope })}
              segments={[
                { value: 'computer', label: t('page.scopes.computer') },
                { value: 'overbench', label: t('page.scopes.overbench') },
              ]}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            aria-label={t('page.range')}
            value={filters.range.kind}
            onChange={(value) => setUsageFilters({ range: { kind: value as RangeKind } })}
            segments={RANGE_KINDS.map((kind) => ({
              value: kind,
              label: t(`page.ranges.${kind}`),
            }))}
          />
          <RangePicker
            value={custom}
            label={custom ? rangeText(custom.from, addDays(custom.to, 1)) : null}
            today={today}
            firstDay={firstDay}
            first={summary.first}
            used={used}
            onApply={(chosen) => setUsageFilters({ range: { kind: 'custom', ...chosen } })}
          />
        </div>
      </div>

      <Figures facts={facts} hours={hours} rangeLabel={rangeText(range.from, range.to)} />

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <TrendCard days={days} hours={hours} page={page} filters={filters} />
        <LimitsCard />
      </div>

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ActivityCard days={heatDays} page={page} />
        <PartsCard facts={facts} />
      </div>

      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
        <BreakdownCard
          title={t('models.title')}
          column={t('models.name')}
          rows={modelRows(summary, agent)}
          total={facts.total}
          nameOf={(row) => row.name ?? t('models.unknown')}
          mono
        />
        <BreakdownCard
          title={t('projects.title')}
          column={t('projects.name')}
          rows={projectRows(summary, agent, basename)}
          total={facts.total}
          nameOf={(row) => row.name ?? t('projects.none')}
        />
      </div>
    </>
  )
}

/** An agent's segment: its mark, with its name in a tooltip and for screen readers. */
function AgentSegment({ agentId }: { agentId: AgentId }) {
  const name = agentName(agentId)
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center px-0.5" />}>
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

function yearOf(day: number): number {
  return new Date(day).getFullYear()
}

function dayText(day: number): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(day)
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn('flex min-w-0 flex-col gap-3 rounded-xl bg-card p-4 shadow-card', className)}
    >
      {children}
    </section>
  )
}

function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex min-h-5 items-baseline gap-2">
      <h2 className="text-ui font-medium">{title}</h2>
      <span className="flex-1" />
      {aside}
    </div>
  )
}

/** A token count, compact, with the exact value in its tooltip. */
function Count({ value, className }: { value: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('tabular-nums', className)} />}>
        {tokens(value)}
      </TooltipTrigger>
      <TooltipContent>{exactCount(value)}</TooltipContent>
    </Tooltip>
  )
}

function Figures({
  facts,
  hours,
  rangeLabel,
}: {
  facts: ReturnType<typeof figures>
  hours: HourTotals | null
  rangeLabel: string
}) {
  const { t } = useTranslation('usage')
  const hourText = useHourText(hours?.zoned ?? false)
  // Re-renders as an hour begins, not on every tick of the clock.
  const begun = useClock((now) => (hours ? hoursSoFar(hours.starts, now).to : 0))
  const hourly = useMemo(
    () => hours && figures(hours.totals, { from: hours.starts[0]!, to: begun }),
    [hours, begun],
  )
  const hourEnd = (start: number) => hours?.starts[hours.starts.indexOf(start) + 1] ?? start
  const figure = (label: string, value: ReactNode, note: string) => (
    <Card className="gap-1.5">
      <span className="text-xs text-tertiary">{label}</span>
      <span className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">{value}</span>
      <span className="text-xs text-pretty text-tertiary">{note}</span>
    </Card>
  )
  const none = <span className="text-tertiary">—</span>
  return (
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
      {figure(
        t('figures.total'),
        facts.total > 0 ? <Count value={facts.total} /> : none,
        t('figures.days', { range: rangeLabel, count: facts.days }),
      )}
      {hourly
        ? figure(
            t('figures.hourlyAverage'),
            hourly.average !== null ? <Count value={Math.round(hourly.average)} /> : none,
            t('figures.activeHours', { active: hourly.activeDays, count: hourly.days }),
          )
        : figure(
            t('figures.average'),
            facts.average !== null ? <Count value={Math.round(facts.average)} /> : none,
            t('figures.active', { active: facts.activeDays, count: facts.days }),
          )}
      {hourly
        ? figure(
            t('figures.peakHour'),
            hourly.peak ? <Count value={hourly.peak.total} /> : none,
            hourly.peak ? hourText(hourly.peak.day, hourEnd(hourly.peak.day)) : t('figures.none'),
          )
        : figure(
            t('figures.peak'),
            facts.peak ? <Count value={facts.peak.total} /> : none,
            facts.peak ? dayText(facts.peak.day) : t('figures.none'),
          )}
      {figure(
        t('figures.cacheShare'),
        facts.cacheShare !== null ? (
          <span className="tabular-nums">{percent(facts.cacheShare)}</span>
        ) : (
          none
        ),
        t('figures.cacheShareNote'),
      )}
    </div>
  )
}

const TREND_TITLE = {
  hour: 'trend.hourly',
  day: 'trend.daily',
  week: 'trend.weekly',
  month: 'trend.monthly',
} as const
/** Hours are labelled every 1, 2, 3, 4, 6 or 12, so the labels fall on the same times each day. */
const HOUR_STEPS = [1, 2, 3, 4, 6, 12]
const NO_SERIES: readonly AgentId[] = []
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
  filters,
}: {
  days: DayTotal[]
  hours: HourTotals | null
  page: PageData
  filters: UsageFilters
}) {
  const { t, i18n } = useTranslation('usage')
  const rangeText = useRangeText()
  const hourText = useHourText(hours?.zoned ?? false)
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
        ? { unit: 'hour' as const, bars: hourBars(hours.totals, hours.starts) }
        : trend(days, page.range, page.firstDay),
    [hours, days, page.range, page.firstDay],
  )
  const series = useMemo(() => seriesOf(bars, AGENT_IDS), [bars])
  // What the legend hides holds until a filter changes.
  const [legend, setLegend] = useState({ filters, hidden: NO_SERIES })
  const hidden = legend.filters === filters ? legend.hidden : NO_SERIES
  const shown = useMemo(() => shownSeries(series, hidden), [series, hidden])
  const toggle = useCallback(
    (chosen: AgentId[]) =>
      setLegend((l) => ({
        filters,
        hidden: legendHidden(series, chosen, l.filters === filters ? l.hidden : NO_SERIES),
      })),
    [filters, series],
  )
  const totals = useMemo(() => shownTotals(bars, shown), [bars, shown])
  const max = Math.max(0, ...totals)
  // Re-renders as an hour begins; a range of days never does.
  const future = useClock((now) => (hours ? bars.filter((bar) => bar.from > now).length : 0))
  const [chosen, setChosen] = useState<number | null>(null)
  const at = chosen !== null && chosen < bars.length - future ? chosen : null
  const index = at ?? busiest(totals)
  const bar = index === null ? null : bars[index]!
  const title = t(TREND_TITLE[unit])
  const describe = (bar: TrendBar) =>
    unit === 'hour'
      ? hourText(bar.from, bar.to)
      : unit === 'day'
        ? dayText(bar.from)
        : // A whole month by its name; one the range cuts by its dates.
          unit === 'month' && bar.from === monthStartOf(bar.from) && bar.to === monthStartOf(bar.to)
          ? new Intl.DateTimeFormat(i18n.language, { month: 'short', year: 'numeric' }).format(
              bar.from,
            )
          : rangeText(bar.from, bar.to)
  const axisText = useMemo(() => {
    if (unit === 'hour') {
      const time = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' })
      return (i: number) => time.format(bars[i]!.from)
    }
    const date: Intl.DateTimeFormatOptions =
      unit === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' }
    const plain = new Intl.DateTimeFormat(i18n.language, date)
    const dated = new Intl.DateTimeFormat(i18n.language, { ...date, year: 'numeric' })
    // Across a new year, the first label and the first of each year name it.
    const years = bars.length > 0 && yearOf(bars[0]!.from) !== yearOf(bars.at(-1)!.from)
    return (i: number, previous: number | null) => {
      const from = bars[i]!.from
      const year = years && (previous === null || yearOf(bars[previous]!.from) !== yearOf(from))
      return (year ? dated : plain).format(from)
    }
  }, [unit, bars, i18n.language])
  return (
    <Card>
      <CardHead
        title={title}
        aside={
          <span aria-live="polite" className="truncate text-xs text-tertiary tabular-nums">
            {bar &&
              !late &&
              t('trend.label', { date: describe(bar), tokens: tokens(totals[index!]!) })}
          </span>
        }
      />
      <div className="flex flex-col gap-1">
        {/* The scale's top on the left; with a legend, each shown agent's part of the bar named. */}
        <div className="flex h-4 justify-between gap-3 text-xs text-tertiary tabular-nums">
          <span aria-hidden>{!late && max > 0 && tokens(max)}</span>
          <span aria-live="polite" className="flex min-w-0 gap-2.5 overflow-hidden">
            {bar &&
              !late &&
              series.length > 1 &&
              shown.map((id) => (
                <span key={id} className="flex shrink-0 items-center gap-1">
                  <span aria-hidden className={cn('size-2 rounded-xs', AGENT_FILL[id])} />
                  {t('trend.agent', { agent: agentName(id), tokens: tokens(bar.byAgent[id] ?? 0) })}
                </span>
              ))}
          </span>
        </div>
        {late ? (
          <Skeleton className="h-40" />
        ) : max === 0 ? (
          <p className="flex h-40 items-center justify-center text-xs text-secondary">
            {t('noUsage')}
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
          <span className="h-4" />
        ) : (
          <TrendAxis
            count={bars.length}
            anchor={unit === 'hour' ? 'start' : 'end'}
            steps={unit === 'hour' ? HOUR_STEPS : undefined}
            text={axisText}
          />
        )}
      </div>
      {series.length > 1 &&
        (late ? (
          <span className="h-control-sm" />
        ) : (
          <TrendLegend series={series} shown={shown} label={t('trend.legend')} onChange={toggle} />
        ))}
    </Card>
  )
}

function LimitsCard() {
  const { t } = useTranslation('usage')
  const agents = useAgentsStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((a): a is AgentStatus => !!a && a.limits.length > 0),
    ),
  )
  // Read afresh when the page opens; the host asks each agent at most once a minute.
  useEffect(() => {
    const { byId } = useAgentsStore.getState()
    for (const agent of Object.values(byId)) {
      if (!agent || agent.state !== 'ready' || agent.limits.length === 0) continue
      refreshLimits(agent.id).catch((error: unknown) =>
        console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
      )
    }
  }, [])
  return (
    <Card className="gap-1 px-0 pb-1">
      <div className="px-4">
        <CardHead title={t('limits.title')} />
      </div>
      {agents.length === 0 ? (
        <p className="px-4 pt-1 pb-3 text-xs text-secondary">{t('limits.none')}</p>
      ) : (
        agents.map((status) => (
          <LimitsPart
            key={status.id}
            titled={false}
            limits={status.limits}
            account={status.account}
            agent={{ id: status.id, name: status.name }}
          />
        ))
      )}
    </Card>
  )
}

function ActivityCard({ days, page }: { days: DayTotal[]; page: PageData }) {
  const { t, i18n } = useTranslation('usage')
  const [shown, setShown] = useState<DayTotal | null>(null)
  const monthLabel = useCallback(
    (day: number) => new Intl.DateTimeFormat(i18n.language, { month: 'short' }).format(day),
    [i18n.language],
  )
  const weekdayLabel = useCallback(
    (day: number) => new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(day),
    [i18n.language],
  )
  const outside = days.some((d) => d.day < page.range.from || d.day >= page.range.to)
  return (
    <Card>
      <CardHead
        title={t('activity.title')}
        aside={
          <span aria-live="polite" className="truncate text-xs text-tertiary tabular-nums">
            {shown
              ? t('trend.label', { date: dayText(shown.day), tokens: tokens(shown.total) })
              : t('activity.weeks')}
          </span>
        }
      />
      <Heatmap
        days={days}
        range={page.range}
        label={t('activity.label')}
        monthLabel={monthLabel}
        weekdayLabel={weekdayLabel}
        onShow={setShown}
      />
      <div className="flex items-center gap-2 text-xs text-tertiary">
        {outside && <span>{t('activity.outside')}</span>}
        <span className="flex-1" />
        <HeatLegend less={t('activity.less')} more={t('activity.more')} />
      </div>
    </Card>
  )
}

const PART_FILL = {
  cacheRead: 'bg-heat-1',
  input: 'bg-heat-4',
  cacheWrite: 'bg-heat-2',
  output: 'bg-foreground/80',
  reasoning: 'bg-heat-3',
} as const

function PartsCard({ facts }: { facts: ReturnType<typeof figures> }) {
  const { t } = useTranslation('usage')
  const rows = (['cacheRead', 'input', 'cacheWrite', 'output', 'reasoning'] as const).filter(
    (part) => part !== 'reasoning' || facts.parts.reasoning > 0,
  )
  return (
    <Card>
      <CardHead title={t('parts.title')} />
      <table className="w-full text-xs tabular-nums">
        <thead className="text-tertiary">
          <tr>
            <th className="pb-1.5 text-left font-normal">{t('parts.type')}</th>
            <th className="pb-1.5 text-right font-normal">{t('parts.tokens')}</th>
            <th className="w-14 pb-1.5 text-right font-normal">{t('parts.share')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((part) => (
            <tr key={part} className="border-t border-subtle">
              <td className="py-1.5">
                <span className="flex items-center gap-2">
                  <span aria-hidden className={cn('size-2 rounded-xs', PART_FILL[part])} />
                  {t(`parts.${part}`)}
                </span>
              </td>
              <td className="py-1.5 text-right font-mono">{exactCount(facts.parts[part])}</td>
              <td className="py-1.5 text-right text-tertiary">
                {facts.total > 0 ? percent(facts.parts[part] / facts.total) : '—'}
              </td>
            </tr>
          ))}
          <tr className="border-t border-subtle font-medium">
            <td className="py-1.5">{t('parts.total')}</td>
            <td className="py-1.5 text-right font-mono">{exactCount(facts.total)}</td>
            <td className="py-1.5 text-right text-tertiary">
              {facts.total > 0 ? percent(1) : '—'}
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  )
}

function BreakdownCard({
  title,
  column,
  rows,
  total,
  nameOf,
  mono = false,
}: {
  title: string
  column: string
  rows: BreakdownRow[]
  total: number
  nameOf: (row: BreakdownRow) => string
  mono?: boolean
}) {
  const { t } = useTranslation('usage')
  return (
    <Card>
      <CardHead title={title} />
      {rows.length === 0 ? (
        <p className="text-xs text-secondary">{t('noUsage')}</p>
      ) : (
        <table className="w-full table-fixed text-xs tabular-nums">
          <thead className="text-tertiary">
            <tr>
              <th className="pb-1.5 text-left font-normal">{column}</th>
              <th className="w-36 pb-1.5 text-right font-normal">{t('parts.tokens')}</th>
              <th className="w-14 pb-1.5 text-right font-normal">{t('parts.share')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-subtle">
                <td className="py-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className={cn('block truncate', mono && row.name && 'font-mono')} />
                      }
                    >
                      {nameOf(row)}
                    </TooltipTrigger>
                    <TooltipContent>{row.path ?? nameOf(row)}</TooltipContent>
                  </Tooltip>
                </td>
                <td className="py-1.5 text-right font-mono">{exactCount(row.total)}</td>
                <td className="py-1.5 text-right text-tertiary">
                  {total > 0 ? percent(row.total / total) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
