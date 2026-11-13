// Usage on affectUI's Analytics screen: the head with the period, the filters, then the plan
// limits, the figures, where the tokens come from and what they went to, the usage over time
// with one line per agent, the time of day and the activity of the last year.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ChartLineData01Icon,
  ComputerIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { sortAgentIds, type AgentId } from '@shared/thread'
import type { UsageScope } from '@shared/usage'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { CompactBreakdown, type BreakdownItem } from '@renderer/components/affect/compact-breakdown'
import { DateRangePicker } from '@renderer/components/affect/date-range-picker'
import { KpiChart } from '@renderer/components/affect/kpi-chart'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { useRefresh } from '@renderer/components/refresh'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Notice } from '@renderer/features/routines/kit'
import { useCornered } from '@renderer/features/shell/corner'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { AwayContent, WindowHostAway } from '@renderer/features/shell/window-host-away'
import { basename, bytes, count, longAgo, percent, tokens, usd } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { currentLocale } from '@renderer/lib/i18n'
import { isMac } from '@renderer/lib/platform'
import { useClock, useNow } from '@renderer/lib/use-now'
import { HostScopeContext, useHostScope } from '@renderer/stores/host-scope'
import { openReport } from '@renderer/stores/report'
import {
  loadUsagePage,
  setUsageFilters,
  syncUsage,
  usageDayTurned,
  usagePageShown,
  useUsageStore,
  type UsagePage as PageData,
} from '@renderer/stores/usage'
import {
  useHostName,
  useNamesHosts,
  useWindowHost,
  useWindowHostAway,
  useWindowScope,
} from '@renderer/stores/window-host'
import { Activity } from './activity'
import {
  addDays,
  agentRows,
  clocksChange,
  dayOf,
  dayTotals,
  figures,
  firstDayOfWeek,
  foldRows,
  fromCache,
  hourBars,
  hoursSoFar,
  legendHidden,
  metricKind,
  modelRows,
  namesYear,
  presets,
  projectRows,
  RANGE_KINDS,
  seriesOf,
  shownSeries,
  tokenParts,
  tokensPerRequest,
  trend,
  unpricedTokens,
  wholeMonth,
  type AgentFilter,
  type DayTotal,
  type Metric,
  type MetricKind,
  type RangeKind,
  type TrendBar,
  type TrendUnit,
} from './model'
import { PlanLimits } from './plan-limits'
import { useAgentColor, usageAgentName } from './series'
import { TimeOfDay } from './time-of-day'
import { Count, FigureValue } from './count'
import { dayText, useHourText, useRangeText } from './text'
import './usage.css'

/** A scan with less than this to read is over before its progress is worth showing. */
const IMPORT_SHOWN = 50_000_000

/** A one-day range's totals per hour, and the hour starts they were summed over. */
interface HourTotals {
  totals: DayTotal[]
  starts: number[]
  /** The clocks change that day, so its hours name their time zones. */
  zoned: boolean
}

/**
 * The usage page: a dashboard of the tokens the agents used, for a chosen agent and range, on the
 * window's host or every host added up. Its status and settings are the window's host's, this
 * computer's while every host is shown; its plan limits are every shown host's.
 */
export default function UsagePage() {
  const scope = useWindowScope()
  return (
    <HostScopeContext.Provider value={scope}>
      <AgentMarkHost.Provider value={scope.hostId}>
        <Page />
      </AgentMarkHost.Provider>
    </HostScopeContext.Provider>
  )
}

function Page() {
  const { t } = useTranslation('usage')
  const { useUsageStore: useStatusStore } = useHostScope()
  const unavailable = useStatusStore((s) => s.status?.unavailable ?? false)
  const importing = useStatusStore((s) => (s.status?.scanning?.bytes ?? 0) >= IMPORT_SHOWN)
  const fromComputer = useStatusStore((s) => !!s.status?.fromComputer)
  const page = useUsageStore((s) => s.page)
  const error = useUsageStore((s) => s.error)
  // Kettu only can be empty while the logs are not; the filters must stay to switch back.
  const narrowed = useUsageStore((s) => s.filters.scope === 'kettu') && fromComputer
  const away = useWindowHostAway() !== null

  useEffect(() => {
    usagePageShown(true)
    return () => usagePageShown(false)
  }, [])

  const empty = !!page && page.summary.first === null && !narrowed
  let body: ReactNode
  if (away) {
    // What was last read from the host, greyed and read-only; nothing when it never answered.
    body = page ? (
      <Dashboard page={page} notice={null} away />
    ) : (
      <>
        <Head page={null} used={NO_DAYS} bare />
        <div className="k-u__alone">
          <WindowHostAway read={false} />
        </div>
      </>
    )
  } else if (unavailable) {
    body = (
      <>
        <Head page={null} used={NO_DAYS} bare />
        <div className="k-u__alone">
          <Unavailable />
        </div>
      </>
    )
  } else if (empty) {
    // A first import fills the page as it goes; until then its progress stands in for it.
    body = (
      <>
        <Head page={null} used={NO_DAYS} bare />
        <div className="k-u__alone">{importing ? <ImportProgress alone /> : <FirstRun />}</div>
      </>
    )
  } else if (!page) {
    body = (
      <>
        <Head page={null} used={NO_DAYS} />
        <Filters page={null} />
        <div className="k-u__content">
          {error ? <ReadFailed error={error} kept={false} /> : <LoadingState />}
        </div>
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
    <div className="k-u">
      <h1 className="sr-only">{t('page.title')}</h1>
      {body}
    </div>
  )
}

const NO_DAYS: ReadonlySet<number> = new Set()

/**
 * The sticky head: the title, then the range picker and the periods. On macOS with the sidebar
 * collapsed it leaves room for the controls in the corner.
 */
function Head({
  page,
  used,
  bare = false,
  away = false,
}: {
  page: PageData | null
  used: ReadonlySet<number>
  /** Only the title, with nothing to filter yet. */
  bare?: boolean
  /** The figures are what was last read from a host that is away, so nothing can be chosen. */
  away?: boolean
}) {
  const { t } = useTranslation('usage')
  const cornered = useCornered()
  const host = useHostText()
  const range = useUsageStore((s) => s.filters.range)
  const clockDay = useClock(dayOf)
  const today = page?.today ?? clockDay
  const firstDay = page?.firstDay ?? firstDayOfWeek(currentLocale())
  const first = page?.summary.first ?? null
  const custom = range.kind === 'custom' ? range : null
  const shown = custom
    ? { start: new Date(custom.from), end: new Date(custom.to) }
    : page
      ? { start: new Date(page.range.from), end: new Date(addDays(page.range.to, -1)) }
      : { start: new Date(today), end: new Date(today) }
  const choices = useMemo(
    () =>
      presets(today, firstDay).map((preset) => ({
        id: preset.id,
        label: t(`picker.presets.${preset.id}`),
        range: () => ({ start: new Date(preset.from), end: new Date(preset.to) }),
      })),
    [today, firstDay, t],
  )
  return (
    <header className="k-u__head app-region-drag" data-cornered={cornered || undefined}>
      <span className="k-u__lead">
        {cornered && <CornerControlsSpace />}
        <span aria-hidden className="k-u__title">
          {t('page.title')}
        </span>
        {host && <span className="k-u__host">{host}</span>}
      </span>
      {!bare && (
        <AwayContent away={away}>
          <span className="k-u__actions">
            <DateRangePicker
              className="k-u__range"
              align="end"
              compare={false}
              locale={currentLocale()}
              weekStartsOn={firstDay === 0 ? 0 : 1}
              today={new Date(today)}
              max={new Date(today)}
              min={first === null ? undefined : new Date(dayOf(first))}
              presets={choices}
              value={shown}
              marked={(day) => used.has(day.getTime())}
              labels={{
                choose: t('picker.label'),
                presets: t('picker.presetsLabel'),
                custom: t('picker.custom'),
                previousMonth: t('picker.previousMonth'),
                nextMonth: t('picker.nextMonth'),
                pickEnd: (start) => t('picker.pickEnd', { start }),
                days: (n) => t('picker.days', { count: n }),
                cancel: t('picker.cancel'),
                apply: t('picker.apply'),
              }}
              onChange={(chosen) =>
                setUsageFilters({
                  range: {
                    kind: 'custom',
                    from: dayOf(chosen.start.getTime()),
                    to: dayOf(chosen.end.getTime()),
                  },
                })
              }
            />
            <SegmentedControl<RangeKind>
              aria-label={t('page.range')}
              variant="tray"
              size="lg"
              value={(custom ? '' : range.kind) as RangeKind}
              onChange={(kind) => setUsageFilters({ range: { kind } })}
              options={RANGE_KINDS.map((kind) => ({
                value: kind,
                label: (
                  <>
                    <span aria-hidden>{t(`page.rangesShort.${kind}`)}</span>
                    <span className="sr-only">{t(`page.ranges.${kind}`)}</span>
                  </>
                ),
              }))}
            />
          </span>
        </AwayContent>
      )}
    </header>
  )
}

/** The hosts the page counts, once another host is added: one's name, or All hosts. */
function useHostText(): string | null {
  const { t } = useTranslation('usage')
  const names = useNamesHosts()
  const host = useWindowHost()
  const hostName = useHostName()
  if (!names) return null
  return host.kind === 'all' ? t('page.allHosts') : hostName(host.hostId)
}

/** A filter's button, as wide as its longest choice, so picking one never moves what follows. */
function Picker<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value: T
  choices: readonly (Omit<MenuItem, 'checked' | 'onSelect'> & { value: T })[]
  onChange: (value: T) => void
}) {
  return (
    <Dropdown
      align="start"
      items={choices.map(({ value: choice, ...item }) => ({
        ...item,
        checked: choice === value,
        onSelect: () => onChange(choice),
      }))}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="ui-as-tool ui-as-tool--label k-u-pick"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
        >
          <span className="k-u-pick__label">{label}</span>
          <span className="k-u-pick__value">
            {choices.map((choice) => (
              <span
                key={choice.value}
                className="k-u-pick__opt"
                data-on={choice.value === value || undefined}
                aria-hidden={choice.value !== value || undefined}
              >
                {choice.logo}
                {choice.label}
              </span>
            ))}
          </span>
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      )}
    />
  )
}

/** What is counted: the agents and the source, the metric, then the sync state at the end. */
function Filters({ page }: { page: PageData | null }) {
  const { t } = useTranslation('usage')
  const onHost = useHostContext()
  const all = useWindowHost().kind === 'all'
  const { useUsageStore: useStatusStore } = useHostScope()
  const filters = useUsageStore((s) => s.filters)
  // null until the status arrives, when the sync state shows nothing either.
  const fromComputer = useStatusStore((s) => s.status?.fromComputer ?? null)
  const { agent, scope, metric } = filters
  const agents = page?.summary.agents ?? []
  // A chosen agent stays a choice once its usage is gone, as after clearing the record.
  const choices = agent === 'all' || agents.includes(agent) ? agents : [...agents, agent]
  // This computer is "This Mac" on a Mac, and the host's name on another host or in a browser.
  const computer = all
    ? t('page.allHosts')
    : t('page.scopes.computer', onHost.context ? onHost : isMac ? { context: 'mac' } : {})
  return (
    <div className="k-u__filters">
      {/* With usage from one agent only, All is the only choice. */}
      {choices.length > 1 && (
        <Picker<AgentFilter>
          label={t('page.agents')}
          value={agent}
          choices={[
            { value: 'all', label: t('page.allAgents') },
            ...choices.map((id, i) => ({
              value: id,
              label: usageAgentName(id),
              logo: <AgentMark agent={id} size={16} />,
              divider: i === 0,
            })),
          ]}
          onChange={(next) => setUsageFilters({ agent: next })}
        />
      )}
      {fromComputer && (
        <Picker<UsageScope>
          label={t('page.scope')}
          value={scope}
          choices={[
            {
              value: 'computer',
              label: computer,
              icon: ComputerIcon,
              description: t('page.scopeNotes.computer'),
            },
            {
              value: 'kettu',
              label: t('page.scopes.kettu'),
              description: t('page.scopeNotes.kettu'),
            },
          ]}
          onChange={(next) => setUsageFilters({ scope: next })}
        />
      )}
      <SegmentedControl<Metric>
        aria-label={t('page.metric')}
        variant="tray"
        size="md"
        value={metric}
        onChange={(next) => setUsageFilters({ metric: next })}
        options={[
          { value: 'tokens', label: t('metrics.tokens') },
          { value: 'requests', label: t(`metrics.${metricKind('requests', scope)}`) },
          { value: 'cost', label: t('metrics.cost') },
        ]}
      />
      <SyncState />
    </div>
  )
}

/** When the logs were last read, and Sync; or where the figures come from. */
function SyncState() {
  const { t } = useTranslation('usage')
  const { hostId, useUsageStore: useStatusStore } = useHostScope()
  const fromComputer = useStatusStore((s) => s.status?.fromComputer ?? null)
  const synced = useStatusStore(
    (s) =>
      s.status?.logs.reduce<number | null>(
        (latest, log) =>
          log.syncedAt !== null && (latest === null || log.syncedAt > latest)
            ? log.syncedAt
            : latest,
        null,
      ) ?? null,
  )
  const reading = useStatusStore((s) => s.status?.scanning != null)
  const now = useNow()
  const refresh = useRefresh({ busy: reading })
  const [failed, setFailed] = useState<string | null>(null)
  if (fromComputer === null) return null
  if (!fromComputer) return <span className="k-u__sync">{t('page.record')}</span>
  const scanning = refresh.phase === 'turning'
  return (
    <span className="k-u__sync">
      {failed && !scanning ? (
        <Tooltip>
          <TooltipTrigger render={<span role="alert" />}>{t('page.syncFailed')}</TooltipTrigger>
          <TooltipContent className="max-w-80">{failed}</TooltipContent>
        </Tooltip>
      ) : scanning ? (
        t('page.syncing')
      ) : synced !== null ? (
        t('page.synced', { ago: longAgo(synced, now) })
      ) : null}
      <Button
        size="md"
        variant="secondary"
        className={scanning ? 'k-u-spin' : undefined}
        aria-busy={scanning}
        disabled={scanning}
        icon={<Icon icon={RefreshIcon} size={14} />}
        onClick={() => {
          setFailed(null)
          void refresh
            .run(() => syncUsage(hostId))
            .catch((e: unknown) => setFailed(errorMessage(e)))
        }}
      >
        {t('page.syncAction')}
      </Button>
    </span>
  )
}

/** A read that failed: what failed, that the figures below stay, and Retry. */
function ReadFailed({ error, kept }: { error: string; kept: boolean }) {
  const { t } = useTranslation('usage')
  return (
    <Notice
      tone="red"
      mark={<Icon icon={Alert02Icon} size={16} />}
      title={t('error.title')}
      action={
        <Button size="sm" variant="secondary" onClick={() => void loadUsagePage()}>
          {t('error.retry')}
        </Button>
      }
    >
      {kept ? t('error.kept') : error}
    </Notice>
  )
}

/** The database cannot be read, even after its worker was started again. */
function Unavailable() {
  const { t } = useTranslation('usage')
  return (
    <Notice
      tone="red"
      mark={<Icon icon={Alert02Icon} size={16} />}
      title={t('error.title')}
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void openReport({
              context: { sessionId: null, agentId: null, error: t('error.unavailable') },
            })
          }
        >
          {t('error.report')}
        </Button>
      }
    >
      {t('error.unavailable')}
    </Notice>
  )
}

/** A scan's progress: in place of the page on its first import, else above the figures. */
function ImportProgress({ alone }: { alone: boolean }) {
  const { t } = useTranslation('usage')
  const { useUsageStore: useStatusStore } = useHostScope()
  const scanning = useStatusStore((s) => s.status?.scanning ?? null)
  const logs = useStatusStore((s) => s.status?.logs ?? null)
  if (!scanning) return null
  const share = scanning.bytes > 0 ? scanning.doneBytes / scanning.bytes : 0
  const found = (logs ?? []).filter((log) => log.found === true || log.rows > 0)
  const since = found.reduce<number | null>(
    (first, log) =>
      log.first !== null && (first === null || log.first < first) ? log.first : first,
    null,
  )
  const agents =
    found.length > 0
      ? new Intl.ListFormat(currentLocale()).format(found.map((log) => usageAgentName(log.agentId)))
      : null
  return (
    <div role="status" className="k-u-card k-u-import" data-alone={alone || undefined}>
      <b className="k-num">
        {t('page.importing', { done: bytes(scanning.doneBytes), total: bytes(scanning.bytes) })}
      </b>
      <span
        className="k-u-import__bar"
        role="progressbar"
        aria-label={t('page.syncing')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <i style={{ transform: `scaleX(${share})` }} />
      </span>
      {alone && (
        <p>
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
  const card = (height: number) => (
    <div className="k-u-card" style={{ height }}>
      <span className="k-u-bone" style={{ width: 120 }} />
    </div>
  )
  return (
    <div aria-busy className="k-u-loading">
      <span role="status" className="sr-only">
        {t('page.loading')}
      </span>
      <div className="k-u-plans" data-cols={2}>
        {card(128)}
        {card(128)}
      </div>
      <div className="k-u-figs">
        {card(96)}
        {card(96)}
        {card(96)}
        {card(96)}
      </div>
      <div className="k-u-row">
        {card(232)}
        {card(232)}
      </div>
      {card(280)}
    </div>
  )
}

/** Nothing recorded yet: what will appear, and the offer to read the logs already there. */
function FirstRun() {
  const { t } = useTranslation('usage')
  const onHost = useHostContext()
  const { useSettingsStore } = useHostScope()
  const fromComputer = useSettingsStore((s) => s.settings.usage.fromComputer)
  return (
    <div className="ui-as-empty" data-tall>
      <span className="ui-as-empty__icon">
        <Icon icon={ChartLineData01Icon} size={18} />
      </span>
      <b className="ui-as-empty__title">{t('empty.title')}</b>
      <p className="ui-as-empty__text">
        {fromComputer ? t('empty.waiting') : t('empty.description', onHost)}
      </p>
      {!fromComputer && (
        <Button
          size="md"
          onClick={() => void useSettingsStore.getState().update({ usage: { fromComputer: true } })}
        >
          {t('empty.fromComputer', onHost)}
        </Button>
      )}
    </div>
  )
}

function Dashboard({
  page,
  notice,
  away = false,
}: {
  page: PageData
  notice: ReactNode
  /** What was last read from the window's host while it is away. */
  away?: boolean
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
  // Re-renders as an hour begins; a range of days never does.
  const begun = useClock((now) => (hours ? hoursSoFar(hours.starts, now).to : 0))
  const main = useMemo(
    () => periods(hours, days, range, page.firstDay, metric, scope),
    [hours, days, range, page.firstDay, metric, scope],
  )
  const other = kind === 'requests' || kind === 'turns' ? 'tokens' : 'requests'
  const side = useMemo(
    () => periods(hours, days, range, page.firstDay, other, scope),
    [hours, days, range, page.firstDay, other, scope],
  )
  const past = (bars: TrendBar[]) => (hours ? bars.filter((bar) => bar.from < begun) : bars)
  const rangeText = useRangeText()
  const rangeLabel = rangeText(range.from, range.to)

  return (
    <>
      <Head page={page} used={used} away={away} />
      {away && (
        <div className="k-u__away">
          <WindowHostAway read />
        </div>
      )}
      <AwayContent away={away}>
        <Filters page={page} />
        <div className="k-u__content">
          {notice}
          <PlanLimits used={page.used} />
          <Figures
            facts={facts}
            requestFacts={requestFacts}
            hours={hours}
            begun={begun}
            kind={kind}
            metric={metric}
            scope={scope}
            rangeLabel={rangeLabel}
            bars={past(main.bars).map((bar) => bar.total)}
            sideBars={past(side.bars).map((bar) => bar.total)}
          />
          <div className="k-u-row">
            <Sources
              kind={kind}
              facts={facts}
              tokenFacts={tokenFacts}
              agent={agent}
              rangeLabel={rangeLabel}
              asOf={summary.pricesAsOf}
            />
            <Breakdown
              summary={summary}
              agent={agent}
              metric={metric}
              scope={scope}
              kind={kind}
              rangeLabel={rangeLabel}
            />
          </div>
          <OverTime
            unit={main.unit}
            bars={main.bars}
            begun={hours ? begun : null}
            zoned={hours?.zoned ?? false}
            kind={kind}
            total={facts.total}
            rangeLabel={rangeLabel}
            tokensUsed={days.some((d) => d.total > 0)}
          />
          <div className="k-u-row k-u-row--tod">
            <TimeOfDay
              page={page}
              agent={agent}
              metric={metric}
              scope={scope}
              rangeLabel={rangeLabel}
            />
            <Activity days={days} page={page} metric={metric} scope={scope} />
          </div>
        </div>
      </AwayContent>
    </>
  )
}

/** The range's periods in a metric: by hour for one day, else by day, week or month. */
function periods(
  hours: HourTotals | null,
  days: readonly DayTotal[],
  range: PageData['range'],
  firstDay: number,
  metric: Metric,
  scope: UsageScope,
): { unit: TrendUnit; bars: TrendBar[] } {
  return hours
    ? { unit: 'hour', bars: hourBars(hours.totals, hours.starts, metric, scope) }
    : trend(days, range, firstDay, metric, scope)
}

/** A figure's small bars: the last seven periods, the one marked darker. */
function MiniBars({ values, mark }: { values: readonly number[]; mark: 'last' | 'peak' }) {
  const shown = values.slice(-7)
  if (shown.length === 0) return null
  const max = Math.max(...shown)
  const on = mark === 'last' ? shown.length - 1 : max > 0 ? shown.indexOf(max) : -1
  return (
    <span className="k-u-minibars" aria-hidden="true">
      {shown.map((value, i) => (
        <i
          key={i}
          data-on={i === on || undefined}
          style={{ height: `${max > 0 ? Math.max(8, (value / max) * 100) : 8}%` }}
        />
      ))}
    </span>
  )
}

/**
 * Four figures in a row, two to a row while the page is narrow: the range's total, its average,
 * its busiest day and its requests, or by the hour for one day. The number is compact, with the
 * exact value in its tooltip.
 */
function Figures({
  facts,
  requestFacts,
  hours,
  begun,
  kind,
  metric,
  scope,
  rangeLabel,
  bars,
  sideBars,
}: {
  facts: ReturnType<typeof figures>
  /** The range in requests, or turns under Kettu only, whatever the metric. */
  requestFacts: ReturnType<typeof figures>
  hours: HourTotals | null
  /** The end of the hour under way, for a one-day range. */
  begun: number
  kind: MetricKind
  metric: Metric
  scope: UsageScope
  rangeLabel: string
  /** The metric's periods so far, and those of the last figure's measure. */
  bars: readonly number[]
  sideBars: readonly number[]
}) {
  const { t, i18n } = useTranslation('usage')
  const hourly = useMemo(
    () => hours && figures(hours.totals, { from: hours.starts[0]!, to: begun }, metric, scope),
    [hours, begun, metric, scope],
  )
  const hourlyRequests = useMemo(
    () => hours && figures(hours.totals, { from: hours.starts[0]!, to: begun }, 'requests', scope),
    [hours, begun, scope],
  )
  const clock = new Intl.DateTimeFormat(i18n.language, {
    hour: 'numeric',
    minute: '2-digit',
    ...(hours?.zoned ? { timeZoneName: 'short' } : {}),
  })
  const amount = (value: number): string =>
    kind === 'cost'
      ? usd(value)
      : kind === 'tokens'
        ? t('units.tokens', { value: count(value) })
        : t(kind === 'requests' ? 'units.requests' : 'units.turns', { value: count(value) })
  const shown = (value: number | null, priced = true): ReactNode =>
    value === null || (kind === 'cost' && !priced) ? null : (
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
  const cells: { label: string; value: ReactNode; note: string; bars: ReactNode }[] = [
    {
      label: totalLabel,
      value: shown(facts.activeDays > 0 ? facts.total : null, facts.priced),
      note: t('figures.days', { range: rangeLabel, count: facts.days }),
      bars: <MiniBars values={bars} mark="last" />,
    },
    hourly
      ? {
          label: t('figures.hourlyAverage'),
          value: shown(average, hourly.priced),
          note: t('figures.activeHours', { active: hourly.activeDays, count: hourly.days }),
          bars: <MiniBars values={bars} mark="last" />,
        }
      : {
          label: t('figures.average'),
          value: shown(average, facts.priced),
          note: t('figures.active', { active: facts.activeDays, count: facts.days }),
          bars: <MiniBars values={bars} mark="last" />,
        },
    hourly
      ? {
          label: t('figures.peakHour'),
          value: peak ? clock.format(peak.day) : null,
          note: peak ? amount(peak.total) : t('figures.none'),
          bars: <MiniBars values={bars} mark="peak" />,
        }
      : {
          label: t('figures.peak'),
          value: peak ? dayText(peak.day) : null,
          note: peak ? amount(peak.total) : t('figures.none'),
          bars: <MiniBars values={bars} mark="peak" />,
        },
  ]
  if (kind === 'requests' || kind === 'turns') {
    // Requests lead the card already, so the last figure is the tokens they took.
    const perRequest = tokensPerRequest(facts)
    cells.push({
      label: t('figures.total'),
      value: facts.activeDays > 0 ? <Count value={facts.tokens} /> : null,
      note:
        perRequest === null
          ? t('figures.none')
          : t(kind === 'turns' ? 'figures.perTurn' : 'figures.perRequest', {
              value: count(Math.round(perRequest)),
            }),
      bars: <MiniBars values={sideBars} mark="last" />,
    })
  } else {
    const perPeriod = (hourlyRequests ?? requestFacts).average
    cells.push({
      label: t(`metrics.${requestKind}`),
      value: requestFacts.total > 0 ? <Count value={requestFacts.total} /> : null,
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
      bars: <MiniBars values={sideBars} mark="last" />,
    })
  }
  return (
    <section aria-label={t('figures.label')}>
      <div className="k-u-figs">
        {cells.map((cell, i) => (
          <div
            key={i}
            className="k-u-card k-u-fig ui-as-rise"
            style={{ '--i': i } as CSSProperties}
          >
            <span className="k-u-cap">{cell.label}</span>
            <span className="k-u-fig__row">
              <strong className="k-num" data-none={cell.value === null || undefined}>
                {cell.value ?? '—'}
              </strong>
              {cell.bars}
            </span>
            <small>{cell.note}</small>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The day the prices are from, "Nov 1, 2026". */
function priceDate(asOf: string, language: string): string {
  const [year, month, day] = asOf.split('-').map(Number)
  return new Intl.DateTimeFormat(language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year!, month! - 1, day!))
}

/** The kinds of tokens in the order a tie keeps, the cache's first. */
const COMPOSITION = ['cacheRead', 'input', 'output', 'cacheWrite', 'reasoning'] as const
/** The vendored card's shades, by rank. */
const RANKED = [
  'var(--ui-cbc-c1)',
  'var(--ui-cbc-c2)',
  'var(--ui-cbc-c3)',
  'var(--ui-cbc-c4)',
  'var(--ui-cbc-c5)',
] as const
const ranked = (i: number) => RANKED[Math.min(i, RANKED.length - 1)]!

/**
 * What the range's tokens are made of, always in tokens whatever the metric, with how much the
 * prompt cache served and, at API prices, what it saved. Requests split into no kinds.
 */
function Sources({
  kind,
  facts,
  tokenFacts,
  agent,
  rangeLabel,
  asOf,
}: {
  kind: MetricKind
  facts: ReturnType<typeof figures>
  tokenFacts: ReturnType<typeof figures>
  agent: AgentFilter
  rangeLabel: string
  asOf: string
}) {
  const { t, i18n } = useTranslation('usage')
  if (kind === 'requests' || kind === 'turns') {
    return (
      <div className="k-u-card k-u-cb-empty">
        <span className="k-u-cap">{t('cache.title')}</span>
        <p>{t(`cache.noSplit.${kind}`)}</p>
      </div>
    )
  }
  const { parts } = tokenFacts
  const total = COMPOSITION.reduce((sum, part) => sum + parts[part], 0)
  const shares = new Map(tokenParts(parts, total).map((p) => [p.part, p]))
  const items: BreakdownItem[] = COMPOSITION.filter((part) => shares.has(part))
    .map((part) => ({ id: part, label: t(`parts.${part}`), value: parts[part] }))
    .sort((a, b) => b.value - a.value)
    .map((item, i) => ({ ...item, color: ranked(i) }))
  const cache = fromCache(parts)
  const saved = facts.priced ? facts.parts.cacheSaved : 0
  const line =
    cache.share === null
      ? t('noUsage')
      : cache.read === 0
        ? t('cache.none')
        : t('cache.fromCache', { share: percent(cache.share) })
  const unpriced = unpricedTokens(facts)
  return (
    <CompactBreakdown
      className="k-u-cb"
      title={t('cache.title')}
      items={items}
      format={count}
      totalLabel={
        agent === 'all'
          ? t('cache.totalAll', { range: rangeLabel })
          : t('cache.totalOne', { range: rangeLabel, agent: usageAgentName(agent) })
      }
      footer={
        <span className="k-u-cb__foot">
          {kind === 'cost' ? (
            <>
              {t('cache.prices', { date: priceDate(asOf, i18n.language) })}
              {unpriced !== null && ` · ${t('cache.unpriced', { tokens: tokens(unpriced) })}`}
            </>
          ) : saved > 0 && cache.read > 0 ? (
            <Trans
              t={t}
              i18nKey="cache.savedLine"
              values={{ line, cost: usd(saved) }}
              components={{ b: <b /> }}
            />
          ) : (
            line
          )}
        </span>
      }
    />
  )
}

type Grouping = 'model' | 'project' | 'agent'

/** The range by model, project or agent: the five largest, then the rest folded into one. */
function Breakdown({
  summary,
  agent,
  metric,
  scope,
  kind,
  rangeLabel,
}: {
  summary: PageData['summary']
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
  kind: MetricKind
  rangeLabel: string
}) {
  const { t } = useTranslation('usage')
  const color = useAgentColor()
  const groupings: Grouping[] =
    agent === 'all' ? ['model', 'project', 'agent'] : ['model', 'project']
  const [chosen, setGrouping] = useState<Grouping>('model')
  const grouping = groupings.includes(chosen) ? chosen : 'model'
  const rows = useMemo(
    () =>
      grouping === 'model'
        ? modelRows(summary, agent, metric, scope)
        : grouping === 'project'
          ? projectRows(summary, agent, basename, metric, scope)
          : agentRows(summary, agent, metric, scope),
    [grouping, summary, agent, metric, scope],
  )
  const folded = foldRows(rows)
  const items: BreakdownItem[] = folded.rows.map((row, i) => ({
    id: `${grouping}\n${row.key}`,
    label:
      grouping === 'agent'
        ? usageAgentName(row.key as AgentId)
        : grouping === 'project'
          ? (row.name ?? t('breakdown.noProject'))
          : (row.name ?? t('breakdown.unknownModel')),
    value: row.value ?? 0,
    color: grouping === 'agent' ? color(row.key as AgentId) : ranked(i),
    // A project's name is its folder's; its path tells two of one name apart.
    title: grouping === 'project' ? (row.path ?? undefined) : undefined,
  }))
  if (folded.rest) {
    items.push({
      id: `${grouping}\nrest`,
      label: t(`breakdown.others.${grouping}`, { count: folded.rest.count }),
      value: folded.rest.value ?? 0,
      color: ranked(RANKED.length),
      last: true,
    })
  }
  return (
    <CompactBreakdown
      className="k-u-cb"
      title={t('breakdown.title')}
      periods={groupings.map((id) => ({ id, label: t(`breakdown.groups.${id}`) }))}
      period={grouping}
      onPeriodChange={(id) => setGrouping(id as Grouping)}
      switchLabel={t('breakdown.groupBy')}
      items={items}
      format={kind === 'cost' ? usd : count}
      totalLabel={t('breakdown.total', { metric: t(`metrics.${kind}`), range: rangeLabel })}
      footer={null}
    />
  )
}

/** What the chart counts and by what unit. */
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
} as const satisfies Record<MetricKind, Record<TrendUnit, string>>

/** The range over time, one line per agent; the hours still to come of today are left out. */
function OverTime({
  unit,
  bars,
  begun,
  zoned,
  kind,
  total,
  rangeLabel,
  tokensUsed,
}: {
  unit: TrendUnit
  bars: TrendBar[]
  /** The end of the hour under way for a one-day range; null for a range of days. */
  begun: number | null
  zoned: boolean
  kind: MetricKind
  total: number
  rangeLabel: string
  tokensUsed: boolean
}) {
  const { t, i18n } = useTranslation('usage')
  const color = useAgentColor()
  const rangeText = useRangeText()
  const hourText = useHourText(zoned)
  const series = useMemo(
    () =>
      seriesOf(
        bars,
        sortAgentIds(new Set(bars.flatMap((bar) => Object.keys(bar.byAgent))) as Set<AgentId>),
      ),
    [bars],
  )
  const froms = useMemo(() => bars.map((bar) => bar.from), [bars])
  const { labels, long } = useMemo(() => {
    if (unit === 'hour') {
      const time = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric' })
      return {
        labels: froms.map((from) => time.format(from)),
        long: bars.map((bar) => hourText(bar.from, bar.to)),
      }
    }
    const date: Intl.DateTimeFormatOptions =
      unit === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' }
    const plain = new Intl.DateTimeFormat(i18n.language, date)
    const dated = new Intl.DateTimeFormat(i18n.language, { ...date, year: 'numeric' })
    const monthYear = new Intl.DateTimeFormat(i18n.language, { month: 'short', year: 'numeric' })
    return {
      labels: froms.map((from, i) =>
        (namesYear(froms, i, i > 0 ? i - 1 : null) ? dated : plain).format(from),
      ),
      long: bars.map((bar) =>
        unit === 'day'
          ? dayText(bar.from)
          : unit === 'month' && wholeMonth(bar)
            ? monthYear.format(bar.from)
            : rangeText(bar.from, bar.to),
      ),
    }
  }, [unit, froms, bars, i18n.language, hourText, rangeText])
  // What the legend hides, until the agents drawn change.
  const drawn = series.join(' ')
  const [legend, setLegend] = useState<{ drawn: string; hidden: readonly AgentId[] }>({
    drawn,
    hidden: [],
  })
  const hidden = legend.drawn === drawn ? legend.hidden : []
  const shown = shownSeries(series, hidden)
  const later = (bar: TrendBar) => begun !== null && bar.from >= begun
  const lines = shown.map((id) => ({
    label: usageAgentName(id),
    color: color(id),
    values: bars.map((bar) => (later(bar) ? Number.NaN : (bar.byAgent[id] ?? 0))),
  }))
  const format = kind === 'cost' ? usd : count
  const title = t(TREND_TITLE[kind][unit])
  return (
    <KpiChart
      className="k-u-chart"
      title={title}
      value={format(total)}
      format={format}
      labels={labels}
      tooltipLabels={long}
      series={lines}
      emptyText={kind === 'cost' && tokensUsed ? t('noCost') : t('noUsage')}
      plotLabel={t('trend.plot', { title })}
      footer={
        <span className="k-u-trend-foot">
          <span>
            {series.length === 1
              ? t('trend.footerOne', { agent: usageAgentName(series[0]!), range: rangeLabel })
              : t('trend.footer', { range: rangeLabel })}
          </span>
          {series.length > 1 && (
            <span role="group" aria-label={t('trend.legend')} className="k-u-legend">
              {series.map((id) => {
                const on = shown.includes(id)
                const last = on && shown.length === 1
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={on}
                    title={last ? t('trend.keepOne') : undefined}
                    onClick={() =>
                      setLegend({
                        drawn,
                        hidden: legendHidden(
                          series,
                          on ? shown.filter((other) => other !== id) : [...shown, id],
                          hidden,
                        ),
                      })
                    }
                    className="k-u-legend__item"
                  >
                    <i style={{ background: color(id) }} />
                    {usageAgentName(id)}
                  </button>
                )
              })}
            </span>
          )}
        </span>
      }
    />
  )
}
