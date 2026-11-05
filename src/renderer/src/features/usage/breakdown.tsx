import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import type { UsageScope, UsageSummary } from '@shared/usage'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, count, usd } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  agentRows,
  foldRows,
  modelRows,
  projectRows,
  type AgentFilter,
  type BreakdownRow,
  type Metric,
  type MetricKind,
} from './model'
import { Count } from './count'
import { Panel, PanelTitle } from './panel'
import { useAgentColor } from './series'
import { sharePercent } from './text'

type Grouping = 'model' | 'project' | 'agent'

/** The rows by size, the largest furthest from the card, then the rest folded into one. */
const SHARES = [
  'var(--share-1)',
  'var(--share-2)',
  'var(--share-3)',
  'var(--share-4)',
  'var(--share-5)',
] as const
const REST = 'var(--share-rest)'

const SIZE = 140
const OUTER = 70
const INNER = 46
/** The room between two slices, in degrees. */
const GAP = 1.8

/** A slice of the ring from `start` to `end`, in degrees clockwise from the top. */
function slice(start: number, end: number): string {
  const point = (r: number, angle: number) => {
    const a = ((angle - 90) * Math.PI) / 180
    return `${(OUTER + r * Math.cos(a)).toFixed(2)} ${(OUTER + r * Math.sin(a)).toFixed(2)}`
  }
  // A whole ring is two halves, since an arc cannot start and end at one point.
  if (end - start >= 359.99) return `${slice(0, 180)} ${slice(180, 360)}`
  const large = end - start > 180 ? 1 : 0
  return [
    `M ${point(OUTER, start)}`,
    `A ${OUTER} ${OUTER} 0 ${large} 1 ${point(OUTER, end)}`,
    `L ${point(INNER, end)}`,
    `A ${INNER} ${INNER} 0 ${large} 0 ${point(INNER, start)}`,
    'Z',
  ].join(' ')
}

interface Item {
  key: string
  name: ReactNode
  /** The name in full, for its tooltip and screen readers. */
  label: string
  detail: string | null
  value: number | null
  color: string
}

/**
 * The range by model, project or agent, at half the page: a ring of the five largest and the
 * rest, the total inside it, beside a line for each with its amount and share.
 */
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
  const color = useAgentColor()
  const groupings: Grouping[] =
    agent === 'all' ? ['model', 'project', 'agent'] : ['model', 'project']
  const [chosen, setGrouping] = useState<Grouping>('model')
  const grouping = groupings.includes(chosen) ? chosen : 'model'
  const [hovered, setHovered] = useState<string | null>(null)
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
  const items: Item[] = folded.rows.map((row, i) => {
    const label = rowName(row, grouping, t)
    return {
      key: row.key,
      label,
      name: <RowName row={row} label={label} />,
      detail:
        grouping === 'model' && row.agents.length > 0
          ? new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
              row.agents.map((id) => agentName(id)),
            )
          : null,
      value: row.value,
      color: grouping === 'agent' ? color(row.key as AgentId) : (SHARES[i] ?? REST),
    }
  })
  if (folded.rest) {
    const label = t(`breakdown.others.${grouping}`, { count: folded.rest.count })
    items.push({
      key: '\n',
      label,
      name: label,
      detail: null,
      value: folded.rest.value,
      color: REST,
    })
  }
  const share = (value: number | null) =>
    value !== null && total > 0 ? sharePercent(value / total) : '—'
  const amount = (value: number | null): ReactNode =>
    value === null ? t('noPrice') : kind === 'cost' ? usd(value) : <Count value={value} />
  const drawn = items.filter((item) => (item.value ?? 0) > 0)
  const centerText = kind === 'cost' ? usd(total) : count(total)
  const sum = drawn.reduce((s, item) => s + item.value!, 0)
  const gap = drawn.length > 1 ? GAP : 0
  const slices: { item: Item; d: string }[] = []
  for (let i = 0, angle = 0; i < drawn.length; i++) {
    const item = drawn[i]!
    const start = angle + gap / 2
    angle += (item.value! / sum) * 360
    // A sliver keeps a sliver's width, so it still shows.
    slices.push({ item, d: slice(start, Math.max(start + 0.6, angle - gap / 2)) })
  }
  const spoken = items.map((item) => `${item.label} ${share(item.value)}`).join(', ')
  return (
    <Panel className="pt-3.5 pb-4">
      <div className="mb-3 flex min-h-7.5 items-center gap-2.5">
        <PanelTitle className="flex-1 truncate">{t('breakdown.title')}</PanelTitle>
        <SegmentedControl
          aria-label={t('breakdown.groupBy')}
          value={grouping}
          onChange={(next) => {
            setGrouping(next)
            setHovered(null)
          }}
          segments={groupings.map((value) => ({ value, label: t(`breakdown.groups.${value}`) }))}
        />
      </div>
      {items.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-12 text-control text-tertiary">
          {t('noUsage')}
        </p>
      ) : (
        <div className="flex flex-1 items-center gap-5.5">
          <div role="img" aria-label={spoken} className="relative size-35 shrink-0">
            <svg aria-hidden viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-35">
              {slices.map(({ item, d }) => (
                <path
                  key={item.key}
                  d={d}
                  style={{ fill: item.color }}
                  className={cn(
                    'transition-opacity duration-(--duration-fast)',
                    hovered !== null && hovered !== item.key && 'opacity-35',
                  )}
                  onPointerEnter={() => setHovered(item.key)}
                  onPointerLeave={() => setHovered(null)}
                />
              ))}
            </svg>
            <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span
                className={cn(
                  'font-display leading-5.5 font-bold text-primary tabular-nums',
                  centerText.length > 7 ? 'text-[15px]' : 'text-[18px]',
                )}
              >
                {centerText}
              </span>
              <span className="text-small text-tertiary">{t(`breakdown.units.${kind}`)}</span>
            </span>
          </div>
          <ul className="min-w-0 flex-1">
            {items.map((item, i) => (
              <li
                key={item.key}
                onPointerEnter={() => setHovered(item.key)}
                onPointerLeave={() => setHovered(null)}
                className={cn(
                  '-mx-1.5 grid h-6.75 grid-cols-[9px_minmax(0,1fr)_auto_38px] items-center gap-x-2.5 rounded-md px-1.5 text-hint',
                  i > 0 && 'shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]',
                  hovered === item.key && 'bg-hover shadow-none',
                )}
              >
                <span
                  aria-hidden
                  className="size-2.25 rounded-[3px]"
                  style={{ backgroundColor: item.color }}
                />
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {item.name}
                  {item.detail && (
                    <span className="min-w-0 shrink-[3] truncate text-small text-tertiary">
                      {item.detail}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    'text-right font-medium tabular-nums',
                    item.value === null ? 'text-secondary' : 'text-primary',
                  )}
                >
                  {amount(item.value)}
                </span>
                <span className="text-right text-tertiary tabular-nums">{share(item.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

function rowName(
  row: BreakdownRow,
  grouping: Grouping,
  t: (key: 'breakdown.noProject' | 'breakdown.unknownModel') => string,
): string {
  if (grouping === 'agent') return agentName(row.key as AgentId)
  if (grouping === 'project') return row.name ?? t('breakdown.noProject')
  return row.name ?? t('breakdown.unknownModel')
}

/** A row's name, its folder in the tooltip for a project. */
function RowName({ row, label }: { row: BreakdownRow; label: string }) {
  return (
    <Tooltip disabled={!row.path}>
      <TooltipTrigger render={<span className="min-w-0 truncate text-primary" />}>
        {label}
      </TooltipTrigger>
      <TooltipContent>{row.path}</TooltipContent>
    </Tooltip>
  )
}
