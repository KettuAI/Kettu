import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDownIcon, FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import type { UsageScope, UsageSummary } from '@shared/usage'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, percent, usd } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  agentFill,
  agentRows,
  foldRows,
  modelRows,
  projectRows,
  type AgentFilter,
  type BreakdownRow,
  type Metric,
  type MetricKind,
} from './model'
import { Panel, PanelTitle } from './panel'
import { Count } from './count'

type Grouping = 'model' | 'project' | 'agent'
const GROUPINGS: readonly Grouping[] = ['model', 'project', 'agent']

/** A row: the name, a bar against the largest row, the value and its share. */
const ROW =
  'grid h-10 grid-cols-[minmax(0,1fr)_120px_72px_52px] items-center gap-4 px-3 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)] last:shadow-none'
/** A project's bar, in the neutral series color, since a project is no agent's. */
const PROJECT_FILL = 'bg-agent-other'

/** The range by model, project or agent: the five largest, then the rest folded into one row. */
export function Breakdown({
  summary,
  agent,
  metric,
  scope,
  kind,
  total,
}: {
  summary: Pick<UsageSummary, 'models' | 'projects'>
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
  kind: MetricKind
  /** The range's total in the metric, which the shares are of. */
  total: number
}) {
  const { t } = useTranslation('usage')
  const [grouping, setGrouping] = useState<Grouping>('model')
  const [open, setOpen] = useState(false)
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
  const largest = Math.max(0, ...rows.map((row) => row.value ?? 0))
  const share = (value: number | null) =>
    value !== null && total > 0 ? percent(value / total) : '—'
  const amount = (value: number | null): ReactNode =>
    value === null ? t('noPrice') : kind === 'cost' ? usd(value) : <Count value={value} />
  return (
    <Panel className="px-2 pt-4 pb-1.5">
      <div className="mx-3 mb-3 flex flex-wrap items-center gap-3">
        <PanelTitle className="flex-1">{t('breakdown.title')}</PanelTitle>
        <SegmentedControl
          aria-label={t('breakdown.groupBy')}
          value={grouping}
          onChange={(next) => {
            setGrouping(next)
            setOpen(false)
          }}
          segments={GROUPINGS.map((value) => ({ value, label: t(`breakdown.groups.${value}`) }))}
        />
      </div>
      <ul className="flex flex-col shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
        {rows.length === 0 ? (
          <li className="flex h-10 items-center px-3 text-control text-tertiary">{t('noUsage')}</li>
        ) : (
          (open ? rows : folded.rows).map((row) => (
            <li key={row.key} className={ROW}>
              <RowName row={row} grouping={grouping} />
              <span aria-hidden className="h-1 overflow-hidden rounded-xs bg-border-soft">
                <span
                  className={cn(
                    'block h-full rounded-xs',
                    grouping === 'project'
                      ? PROJECT_FILL
                      : agentFill(grouping === 'agent' ? (row.key as AgentId) : row.agents[0]!),
                  )}
                  style={{
                    width: `${largest > 0 && row.value !== null ? (row.value / largest) * 100 : 0}%`,
                  }}
                />
              </span>
              <span
                className={cn(
                  'text-right text-lede tabular-nums',
                  row.value === null ? 'text-secondary' : 'text-primary',
                )}
              >
                {amount(row.value)}
              </span>
              <span className="text-right text-hint text-tertiary tabular-nums">
                {share(row.value)}
              </span>
            </li>
          ))
        )}
        {folded.rest && (
          <li className={ROW}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
              className="flex items-center gap-1.5 justify-self-start rounded-md text-lede text-secondary outline-none focus-ring hover:text-foreground"
            >
              {open
                ? t('breakdown.fewer')
                : t(`breakdown.others.${grouping}`, { count: folded.rest.count })}
              <ChevronDownIcon
                aria-hidden
                strokeWidth={1.75}
                className={cn(
                  'size-3 text-tertiary transition-transform duration-(--duration-fast)',
                  open && 'rotate-180',
                )}
              />
            </button>
            <span />
            {!open && (
              <>
                <span className="text-right text-lede text-secondary tabular-nums">
                  {amount(folded.rest.value)}
                </span>
                <span className="text-right text-hint text-tertiary tabular-nums">
                  {share(folded.rest.value)}
                </span>
              </>
            )}
          </li>
        )}
      </ul>
    </Panel>
  )
}

/** A row's mark or folder, its name, and for a model the agents that used it. */
function RowName({ row, grouping }: { row: BreakdownRow; grouping: Grouping }) {
  const { t } = useTranslation('usage')
  const name =
    grouping === 'agent'
      ? agentName(row.key as AgentId)
      : grouping === 'project'
        ? (row.name ?? t('breakdown.noProject'))
        : (row.name ?? t('breakdown.unknownModel'))
  const mark = grouping === 'agent' ? (row.key as AgentId) : row.agents[0]
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {grouping === 'project' || !mark ? (
        <FolderIcon aria-hidden className="size-4 shrink-0 text-icon" />
      ) : (
        <AgentMark agent={mark} size={16} />
      )}
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate text-lede font-medium text-primary" />}
        >
          {name}
        </TooltipTrigger>
        <TooltipContent>{row.path ?? name}</TooltipContent>
      </Tooltip>
      {grouping === 'model' && row.agents.length > 0 && (
        <span className="min-w-0 shrink-[3] truncate text-hint text-tertiary">
          {new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
            row.agents.map((id) => agentName(id)),
          )}
        </span>
      )}
    </span>
  )
}
