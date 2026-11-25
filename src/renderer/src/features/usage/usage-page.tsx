// Usage as a grid: the head with what is counted, the range and Sync, then the plan limits, four
// figures, the trend beside its breakdown, the year's activity beside the time of day, and a line
// on what the numbers rest on.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ChartLineData01Icon,
  ComputerIcon,
  DatabaseIcon,
  FilterIcon,
  InformationCircleIcon,
  Layers01Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import type { UsageScope, UsageSource } from '@shared/usage'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { DateRangePicker } from '@renderer/components/affect/date-range-picker'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { AgentMarkHost } from '@renderer/components/agents/agent-mark-host'
import { useRefresh } from '@renderer/components/refresh'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { chosenHost } from '@renderer/features/account/model'
import { Notice } from '@renderer/features/routines/kit'
import { useCornered } from '@renderer/features/shell/corner'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { AwayContent, WindowHostAway } from '@renderer/features/shell/window-host-away'
import { bytes, longAgo, tokens } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { currentLocale } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useClock, useNow } from '@renderer/lib/use-now'
import { switchHost } from '@renderer/stores/host-switch'
import { HostScopeContext, useHostScope } from '@renderer/stores/host-scope'
import { useOtherHosts } from '@renderer/stores/hosts'
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
import { THIS_COMPUTER, useViewStore } from '@renderer/stores/view'
import {
  useHostName,
  useNamesHosts,
  useWindowHostAway,
  useWindowScope,
} from '@renderer/stores/window-host'
import { Activity } from './activity'
import { BreakdownCard } from './breakdown'
import { FigureCards, type HourTotals } from './figures'
import {
  addDays,
  clocksChange,
  dayOf,
  dayTotals,
  figures,
  firstDayOfWeek,
  hourBars,
  hourValues,
  hoursSoFar,
  metricKind,
  oneDay,
  presets,
  RANGE_KINDS,
  trend,
  type AgentFilter,
  type DayTotal,
  type Metric,
  type RangeKind,
  type TrendBar,
  type TrendUnit,
} from './model'
import { PlanLimits } from './plan-limits'
import { usageAgentName } from './series'
import { TimeOfDay } from './time-of-day'
import { TrendCard } from './trend'
import { useRangeText } from './text'
import './usage.css'

/** A scan with less than this to read is over before its progress is worth showing. */
const IMPORT_SHOWN = 50_000_000
const DAY_MS = 86_400_000
/** The computer choice for every host added up; host ids never take this form. */
const ALL_HOSTS = '\nall'

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
          <PlanLimits used={NO_USED} />
          <Unavailable />
        </div>
      </>
    )
  } else if (empty) {
    // A first import fills the page as it goes; until then its progress stands in for it.
    body = (
      <>
        <Head page={null} used={NO_DAYS} bare />
        <div className="k-u__alone">
          <PlanLimits used={NO_USED} />
          {importing ? <ImportProgress alone /> : <FirstRun />}
        </div>
      </>
    )
  } else {
    // The figures stay until a read replaces them, so a failure shows above them; the plan limits
    // show as the agents report them, whether the figures came or not.
    body = (
      <Dashboard
        page={page}
        loading={!page && !error}
        notice={
          (error || (page && importing)) && (
            <>
              {error && <ReadFailed error={error} kept={!!page} />}
              {page && importing && <ImportProgress alone={false} />}
            </>
          )
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
const NO_USED: Readonly<Record<string, readonly AgentId[]>> = {}
const NO_TOTALS: DayTotal[] = []
/** A quicker read shows no loading, so a range switch does not flash. */
const LOADING_AFTER_MS = 200

/**
 * The sticky head: the title, then what is counted (the agents, the computers and the source), the
 * metric and the range, then Sync. On macOS with the sidebar collapsed it leaves room for the
 * controls in the corner. With nothing read yet only the computers can be chosen; while the host
 * is away, nothing but them.
 */
function Head({
  page,
  used,
  bare = false,
  away = false,
  waiting = false,
}: {
  page: PageData | null
  used: ReadonlySet<number>
  /** Only the title and the computers, with nothing to filter yet. */
  bare?: boolean
  /** The figures are what was last read from a host that is away, so nothing can be chosen. */
  away?: boolean
  /** The figures of the range just chosen are being read. */
  waiting?: boolean
}) {
  const { t } = useTranslation('usage')
  const cornered = useCornered()
  return (
    <header className="k-u__head app-region-drag" data-cornered={cornered || undefined}>
      <span className="k-u__lead">
        {cornered && <CornerControlsSpace />}
        <span aria-hidden className="k-u__title">
          {t('page.title')}
        </span>
        {waiting && <Spinner className="k-u__wait" />}
      </span>
      <span className="k-u__actions">
        {bare ? (
          <ComputerPicker />
        ) : (
          <>
            <span className="k-u__group">
              <span className="k-u__group" inert={away || undefined} data-away={away || undefined}>
                <AgentPicker page={page} />
              </span>
              <ComputerPicker />
              <span className="k-u__group" inert={away || undefined} data-away={away || undefined}>
                <SourcePicker />
              </span>
            </span>
            <span
              className="k-u__group"
              data-ruled=""
              inert={away || undefined}
              data-away={away || undefined}
            >
              <MetricSwitch />
              <RangeChoice page={page} used={used} />
            </span>
            <SyncButton away={away} />
          </>
        )}
      </span>
    </header>
  )
}

/** A filter's button, as wide as its longest choice, so picking one never moves what follows. */
function Picker<T extends string>({
  icon,
  label,
  value,
  choices,
  onChange,
}: {
  icon: Parameters<typeof Icon>[0]['icon']
  /** What the filter chooses, for those who cannot see its icon. */
  label: string
  value: T
  choices: readonly (Omit<MenuItem, 'checked' | 'onSelect'> & { value: T })[]
  onChange: (value: T) => void
}) {
  const current = choices.find((choice) => choice.value === value)
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
          aria-label={current ? `${label}: ${current.label}` : label}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
        >
          <Icon icon={icon} size={14} />
          <span aria-hidden className="k-u-pick__value">
            {choices.map((choice) => (
              <span
                key={choice.value}
                className="k-u-pick__opt"
                data-on={choice.value === value || undefined}
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

/** The agents with usage, once there are two or more; with one, All is the only choice. */
function AgentPicker({ page }: { page: PageData | null }) {
  const { t } = useTranslation('usage')
  const agent = useUsageStore((s) => s.filters.agent)
  const agents = page?.summary.agents ?? []
  // A chosen agent stays a choice once its usage is gone, as after clearing the record.
  const choices = agent === 'all' || agents.includes(agent) ? agents : [...agents, agent]
  if (choices.length <= 1) return null
  return (
    <Picker<AgentFilter>
      icon={FilterIcon}
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
  )
}

/** Which computers the page counts, once another is added: this one, another, or all of them. */
function ComputerPicker() {
  const { t } = useTranslation('usage')
  const names = useNamesHosts()
  const hosts = useOtherHosts()
  const filter = useViewStore((s) => s.hostFilter)
  const hostName = useHostName()
  // The web client is one host's, which it never switches.
  if (!names || isWeb) return null
  const value =
    chosenHost(
      filter,
      hosts.map((host) => host.id),
    ) ?? ALL_HOSTS
  return (
    <Picker<string>
      icon={ComputerIcon}
      label={t('page.computer')}
      value={value}
      choices={[
        { value: THIS_COMPUTER, label: hostName(null) },
        ...hosts.map((host) => ({ value: host.id, label: host.name })),
        { value: ALL_HOSTS, label: t('page.allHosts'), icon: Layers01Icon, divider: true },
      ]}
      onChange={(next) => {
        const choice = next === ALL_HOSTS ? null : next
        const host = hosts.find((h) => h.id === choice)
        switchHost(choice, host?.connection.state === 'connecting')
      }}
    />
  )
}

/** The logs and Kettu's record, or Kettu's record alone, once the logs are counted. */
function SourcePicker() {
  const { t } = useTranslation('usage')
  const { useUsageStore: useStatusStore } = useHostScope()
  const fromComputer = useStatusStore((s) => s.status?.fromComputer ?? false)
  const scope = useUsageStore((s) => s.filters.scope)
  if (!fromComputer) return null
  return (
    <Picker<UsageScope>
      icon={DatabaseIcon}
      label={t('page.scope')}
      value={scope}
      choices={[
        {
          value: 'computer',
          label: t('page.scopes.computer'),
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
  )
}

function MetricSwitch() {
  const { t } = useTranslation('usage')
  const metric = useUsageStore((s) => s.filters.metric)
  const scope = useUsageStore((s) => s.filters.scope)
  return (
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
  )
}

/** The ranges by length, then a calendar for any other, which names the range it holds. */
function RangeChoice({ page, used }: { page: PageData | null; used: ReadonlySet<number> }) {
  const { t } = useTranslation('usage')
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
    <>
      <SegmentedControl<RangeKind>
        aria-label={t('page.range')}
        variant="tray"
        size="md"
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
      <DateRangePicker
        className={custom ? 'k-u__cal k-u__cal--custom' : 'k-u__cal'}
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
    </>
  )
}

/**
 * Sync: reads the agents' logs now, the last read in its tooltip and a failure on it. Kettu's
 * record alone has nothing to read, so it shows none then.
 */
function SyncButton({ away }: { away: boolean }) {
  const { t } = useTranslation('usage')
  const { hostId, useUsageStore: useStatusStore } = useHostScope()
  const fromComputer = useStatusStore((s) => s.status?.fromComputer ?? false)
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
  if (!fromComputer) return null
  const scanning = refresh.phase === 'turning'
  const state =
    failed && !scanning
      ? t('page.syncFailed')
      : scanning
        ? t('page.syncing')
        : synced !== null
          ? t('page.synced', { ago: longAgo(synced, now) })
          : null
  return (
    <span
      className="k-u__group"
      data-ruled=""
      inert={away || undefined}
      data-away={away || undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="ui-as-tool k-u__sync"
              aria-label={state ? `${t('page.sync')}: ${state}` : t('page.sync')}
              aria-busy={scanning || undefined}
              data-turning={scanning || undefined}
              data-failed={(failed && !scanning) || undefined}
              disabled={scanning}
              onClick={() => {
                setFailed(null)
                void refresh
                  .run(() => syncUsage(hostId))
                  .catch((e: unknown) => setFailed(errorMessage(e)))
              }}
            />
          }
        >
          <Icon icon={RefreshIcon} size={15} />
        </TooltipTrigger>
        <TooltipContent className="max-w-80 flex-col items-start">
          <b>{t('page.sync')}</b>
          {state && <span>{state}</span>}
          {failed && !scanning && <span>{failed}</span>}
        </TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {failed && !scanning ? t('page.syncFailed') : ''}
      </span>
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
        <Button size="md" variant="secondary" onClick={() => void loadUsagePage()}>
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
          size="md"
          variant="secondary"
          onClick={() =>
            void openReport({
              origin: 'usage',
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

/** The grid's wells, empty, while the first figures are read. */
function LoadingState() {
  const { t } = useTranslation('usage')
  const well = (span: number, height: number) => (
    <div className={`k-u-card k-u-span-${span} k-u-bones`} style={{ height }}>
      <span className="k-u-bone" style={{ width: 96 }} />
      <span className="k-u-bone" style={{ width: '40%' }} />
    </div>
  )
  return (
    <div aria-busy className="k-u__body">
      <span role="status" className="sr-only">
        {t('page.loading')}
      </span>
      {well(3, 112)}
      {well(3, 112)}
      {well(3, 112)}
      {well(3, 112)}
      {well(8, 300)}
      {well(4, 300)}
      {well(8, 236)}
      {well(4, 236)}
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
  loading = false,
  away = false,
}: {
  page: PageData | null
  notice: ReactNode
  /** The first figures are being read. */
  loading?: boolean
  /** What was last read from the window's host while it is away. */
  away?: boolean
}) {
  const allDays = useMemo(
    () => (page ? dayTotals(page.summary, page.starts, 'all') : NO_TOTALS),
    [page],
  )
  const used = useMemo(
    () => new Set(allDays.filter((d) => d.total > 0).map((d) => d.day)),
    [allDays],
  )
  const waiting = useWaiting(page) && !away
  return (
    <>
      <Head page={page} used={used} away={away} waiting={waiting} />
      <div className="k-u__content">
        {away && <WindowHostAway read />}
        {notice}
        <AwayContent away={away}>
          <div className="k-u__stack">
            <PlanLimits used={page?.used ?? NO_USED} />
            {page ? (
              <Body page={page} allDays={allDays} waiting={waiting} />
            ) : (
              loading && <LoadingState />
            )}
          </div>
        </AwayContent>
      </div>
    </>
  )
}

/**
 * Whether the figures shown were read for another range or source than the one chosen, once the
 * read for it has taken a moment; a failed read says so itself.
 */
function useWaiting(page: PageData | null): boolean {
  const filters = useUsageStore((s) => s.filters)
  const failed = useUsageStore((s) => s.error !== null)
  const other =
    !!page &&
    !failed &&
    (page.filters.range !== filters.range || page.filters.scope !== filters.scope)
  const [late, setLate] = useState<object | null>(null)
  useEffect(() => {
    if (!other) return
    const timer = setTimeout(() => setLate(filters), LOADING_AFTER_MS)
    return () => clearTimeout(timer)
  }, [other, filters])
  return other && late === filters
}

/** The figures and charts on the grid, dimmed while those of a newly chosen range are read. */
function Body({
  page,
  allDays,
  waiting,
}: {
  page: PageData
  allDays: DayTotal[]
  waiting: boolean
}) {
  const filters = useUsageStore((s) => s.filters)
  const { summary, starts, range } = page
  const { agent, metric, scope } = filters
  const kind = metricKind(metric, scope)

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
  // In tokens whatever the metric: the kinds of token and the cost.
  const facts = useMemo(() => figures(days, range), [days, range])
  // Re-renders as an hour begins; a range of days never does.
  const begun = useClock((now) => (hours ? hoursSoFar(hours.starts, now).to : 0))
  const main = useMemo(
    () => periods(hours, days, range, page.firstDay, metric, scope),
    [hours, days, range, page.firstDay, metric, scope],
  )
  // For today, each hour's daily average over the days the hours of the day cover.
  const hourAverage = useMemo(() => {
    if (!oneDay(range)) return null
    const spanDays = Math.max(1, Math.round((page.clock.to - page.clock.from) / DAY_MS))
    return hourValues(summary.clock, agent, metric, scope).map((value) => value / spanDays)
  }, [range, page.clock, summary.clock, agent, metric, scope])
  const rangeText = useRangeText()

  return (
    <div className="k-u__body" aria-busy={waiting || undefined} data-busy={waiting || undefined}>
      <FigureCards
        page={page}
        days={days}
        hours={hours}
        begun={begun}
        agent={agent}
        scope={scope}
      />
      <TrendCard
        className="k-u-span-8"
        unit={main.unit}
        bars={main.bars}
        begun={hours ? begun : null}
        zoned={hours?.zoned ?? false}
        kind={kind}
        hourAverage={hourAverage}
        tokensUsed={facts.tokens > 0}
        today={page.today}
        firstDay={page.firstDay}
      />
      <BreakdownCard
        className="k-u-span-4"
        summary={summary}
        facts={facts}
        agent={agent}
        metric={metric}
        scope={scope}
        kind={kind}
      />
      <Activity className="k-u-span-8" days={days} page={page} metric={metric} scope={scope} />
      <TimeOfDay
        className="k-u-span-4"
        page={page}
        agent={agent}
        metric={metric}
        scope={scope}
        rangeLabel={rangeText(range.from, range.to)}
      />
      <Footnote page={page} agent={agent} unpriced={facts.parts.unpricedTokens} />
    </div>
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

/** The day the prices are from, "Nov 1, 2026". */
function priceDate(asOf: string, language: string): string {
  const [year, month, day] = asOf.split('-').map(Number)
  return new Intl.DateTimeFormat(language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(year!, month! - 1, day!))
}

/** This computer's offset from UTC as the locale writes it, "GMT-8". */
function zoneName(language: string, at: number): string {
  const parts = new Intl.DateTimeFormat(language, { timeZoneName: 'shortOffset' }).formatToParts(at)
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
}

/**
 * What the numbers rest on: the price list and the tokens it has no price for, then where each
 * agent's usage is counted from and the time zone the days and hours are in.
 */
function Footnote({
  page,
  agent,
  unpriced,
}: {
  page: PageData
  agent: AgentFilter
  unpriced: number
}) {
  const { t, i18n } = useTranslation('usage')
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
  const bySource = new Map<UsageSource, AgentId[]>()
  for (const [id, source] of Object.entries(page.summary.sources) as [AgentId, UsageSource][]) {
    if (agent !== 'all' && id !== agent) continue
    bySource.set(source, [...(bySource.get(source) ?? []), id])
  }
  const sources = (['log', 'kettu'] as const).flatMap((source) => {
    const ids = bySource.get(source)
    if (!ids) return []
    const agents = list.format(ids.map((id) => usageAgentName(id)))
    return [t(source === 'log' ? 'foot.logs' : 'foot.kettu', { agents, count: ids.length })]
  })
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return (
    <footer className="k-u-note k-u-span-12">
      <Icon icon={InformationCircleIcon} size={13} />
      <span>
        {t('foot.prices', { date: priceDate(page.summary.pricesAsOf, i18n.language) })}
        {unpriced > 0 && ` · ${t('foot.unpriced', { tokens: tokens(unpriced) })}`}
      </span>
      <span className="k-u-note__end" title={zone}>
        {[...sources, t('foot.zone', { zone: zoneName(i18n.language, page.today) })].join(' · ')}
      </span>
    </footer>
  )
}
