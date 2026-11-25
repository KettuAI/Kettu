import { useMemo, useState, type PointerEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import type { UsageScope } from '@shared/usage'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, count, exactCount, percent, usd } from '@renderer/lib/format'
import type { UsagePage as PageData } from '@renderer/stores/usage'
import { ChartTip, TipRow } from './chart'
import { COMPOSITION, PART_COLOR } from './plot'
import {
  agentRows,
  BREAKDOWN_ROWS,
  foldRows,
  fromCache,
  modelRows,
  projectRows,
  type AgentFilter,
  type BreakdownRow,
  type Figures,
  type Metric,
  type MetricKind,
} from './model'
import { useAgentColor, usageAgentName } from './series'
import { shareWhole } from './text'

type Grouping = 'model' | 'project' | 'agent' | 'type'

/** Shares by size: the largest in the deepest orange, the rest folded in gray. */
const SHARES = [
  'var(--share-1)',
  'var(--share-2)',
  'var(--share-3)',
  'var(--share-4)',
  'var(--share-5)',
]
const REST = 'var(--share-rest)'
const DONUT = 92
const DONUT_STROKE = 13
/** The room between two of the donut's parts, along its ring. */
const DONUT_GAP = 1.5

interface Line {
  key: string
  label: string
  /** A project's folder, a model's name in full. */
  title?: string
  mono?: boolean
  color: string
  /** In the metric; null where no price covers it. */
  value: number | null
  /** The third column: the cost, or the tokens while the metric is cost; undefined for none. */
  side?: number | null
  /** What a folded line holds. */
  folded?: string[]
}

/**
 * The range by model, project, agent or kind of token: a donut of the five largest beside the
 * total, then a table of them, the rest folded into one line that lists them on hover. Hovering
 * a part or its line lights both.
 */
export function BreakdownCard({
  summary,
  facts,
  agent,
  metric,
  scope,
  kind,
  className,
}: {
  summary: PageData['summary']
  /** The range's figures in tokens, for the kinds of token and the cost. */
  facts: Figures
  agent: AgentFilter
  metric: Metric
  scope: UsageScope
  kind: MetricKind
  className?: string
}) {
  const { t } = useTranslation('usage')
  const color = useAgentColor()
  const groupings: Grouping[] =
    agent === 'all' ? ['model', 'project', 'agent', 'type'] : ['model', 'project', 'type']
  const [chosen, setGrouping] = useState<Grouping>('model')
  const grouping = groupings.includes(chosen) ? chosen : 'model'
  const [hover, setHover] = useState<{ key: string; at: DOMRect | null } | null>(null)
  const counted = kind === 'requests' || kind === 'turns'
  const format = kind === 'cost' && grouping !== 'type' ? usd : count

  const { lines, all } = useMemo((): { lines: Line[]; all: number } => {
    if (grouping === 'type') {
      const kinds = COMPOSITION.filter((part) => facts.parts[part] > 0).map((part) => ({
        key: part,
        label: t(`parts.${part}`),
        color: PART_COLOR[part],
        value: facts.parts[part],
      }))
      return { lines: kinds, all: kinds.length }
    }
    const rowsOf = (m: Metric) =>
      grouping === 'model'
        ? modelRows(summary, agent, m, scope)
        : grouping === 'project'
          ? projectRows(summary, agent, basename, m, scope)
          : agentRows(summary, agent, m, scope)
    const rows = rowsOf(metric)
    // The third column: the cost beside any other metric, the tokens beside the cost.
    const sides = new Map(
      (metric === 'cost' ? rows : rowsOf('cost')).map((row) => [
        row.key,
        metric === 'cost' ? row.total : row.value,
      ]),
    )
    const nameOf = (row: BreakdownRow) =>
      grouping === 'agent'
        ? usageAgentName(row.key as AgentId)
        : grouping === 'project'
          ? (row.name ?? t('breakdown.noProject'))
          : (row.name ?? t('breakdown.unknownModel'))
    const folded = foldRows(rows)
    const out: Line[] = folded.rows.map((row, i) => ({
      key: row.key,
      label: nameOf(row),
      title: grouping === 'project' ? (row.path ?? undefined) : undefined,
      mono: grouping === 'model' && row.name !== null,
      color: grouping === 'agent' ? color(row.key as AgentId) : SHARES[i]!,
      value: row.value,
      side: sides.get(row.key) ?? null,
    }))
    if (folded.rest) {
      const others = rows.slice(BREAKDOWN_ROWS)
      const sideValues = others.map((row) => sides.get(row.key) ?? null)
      const priced = sideValues.filter((value): value is number => value !== null)
      out.push({
        key: '\nrest',
        label: t(`breakdown.others.${grouping}`, { count: folded.rest.count }),
        color: REST,
        value: folded.rest.value,
        side: priced.length > 0 ? priced.reduce((sum, value) => sum + value, 0) : null,
        folded: others.map((row) => nameOf(row)),
      })
    }
    return { lines: out, all: rows.length }
  }, [grouping, summary, agent, metric, scope, facts.parts, color, t])

  const total = lines.reduce((sum, line) => sum + (line.value ?? 0), 0)
  const noSplit = grouping === 'type' && counted
  const cache = fromCache(facts.parts)
  const tokensTotal = facts.tokens

  return (
    <section className={`k-u-card k-u-bd ${className ?? ''}`} aria-labelledby="breakdown-title">
      <header className="k-u-card__head">
        <h3 id="breakdown-title">{t('breakdown.title')}</h3>
        <SegmentedControl<Grouping>
          aria-label={t('breakdown.groupBy')}
          variant="tray"
          size="sm"
          className="ml-auto"
          value={grouping}
          onChange={setGrouping}
          options={groupings.map((id) => ({ value: id, label: t(`breakdown.groups.${id}`) }))}
        />
      </header>
      {noSplit ? (
        <p className="k-u-bd__none">{t(`cache.noSplit.${kind as 'requests' | 'turns'}`)}</p>
      ) : total <= 0 ? (
        <p className="k-u-bd__none">
          {kind === 'cost' && tokensTotal > 0 ? t('noCost') : t('noUsage')}
        </p>
      ) : (
        <div className="k-u-bd__body" onPointerLeave={() => setHover(null)}>
          <div className="k-u-bd__top">
            <Donut
              lines={lines}
              total={total}
              active={hover?.key ?? null}
              onPoint={(key, at) => setHover(key === null ? null : { key, at })}
            />
            <div className="k-u-bd__sum">
              <strong className="k-num">
                {grouping === 'type' ? count(total) : format(total)}
              </strong>
              <span>
                {grouping === 'type'
                  ? t('breakdown.kinds', { count: all })
                  : t(`breakdown.across.${grouping}`, { count: all })}
              </span>
              <span>
                {grouping === 'type' ? (
                  cache.share !== null && (
                    <Trans
                      t={t}
                      i18nKey="breakdown.fromCache"
                      values={{ share: percent(cache.share) }}
                      components={{ b: <b /> }}
                    />
                  )
                ) : kind === 'cost' ? (
                  <Trans
                    t={t}
                    i18nKey="breakdown.tokens"
                    values={{ tokens: count(tokensTotal) }}
                    components={{ b: <b /> }}
                  />
                ) : facts.parts.cost !== null ? (
                  <Trans
                    t={t}
                    i18nKey="breakdown.atPrices"
                    values={{ cost: usd(facts.parts.cost) }}
                    components={{ b: <b /> }}
                  />
                ) : (
                  t('noPrice')
                )}
              </span>
            </div>
          </div>
          <table className="k-u-bd__table">
            <thead>
              <tr>
                <th scope="col">{t(`breakdown.groups.${grouping}`)}</th>
                <th scope="col">{t(`metrics.${grouping === 'type' ? 'tokens' : kind}`)}</th>
                {grouping !== 'type' && (
                  <th scope="col">{t(kind === 'cost' ? 'metrics.tokens' : 'metrics.cost')}</th>
                )}
                <th scope="col">{t('breakdown.share')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const row = (
                  <tr
                    key={line.key}
                    data-on={hover?.key === line.key || undefined}
                    data-dim={(hover !== null && hover.key !== line.key) || undefined}
                    onPointerEnter={() => setHover({ key: line.key, at: null })}
                  >
                    <th scope="row" title={line.title}>
                      <i style={{ background: line.color }} />
                      <span
                        data-mono={line.mono || undefined}
                        data-rest={!!line.folded || undefined}
                      >
                        {line.label}
                      </span>
                    </th>
                    <td className="k-num">
                      {line.value === null ? t('noPrice') : format(line.value)}
                    </td>
                    {grouping !== 'type' && (
                      <td className="k-num" data-faint="">
                        {line.side == null
                          ? t('noPrice')
                          : kind === 'cost'
                            ? count(line.side)
                            : usd(line.side)}
                      </td>
                    )}
                    <td className="k-num" data-faint="">
                      {line.value === null ? '—' : shareWhole(line.value / total)}
                    </td>
                  </tr>
                )
                return line.folded ? (
                  <Tooltip key={line.key}>
                    <TooltipTrigger render={row} />
                    <TooltipContent className="max-w-72 flex-col items-start">
                      {line.folded.slice(0, 12).map((name) => (
                        <span key={name}>{name}</span>
                      ))}
                      {line.folded.length > 12 &&
                        t('breakdown.andMore', { count: line.folded.length - 12 })}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  row
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <ChartTip at={hover?.at ?? null}>
        {hover?.at &&
          (() => {
            const line = lines.find((l) => l.key === hover.key)
            if (!line) return null
            return (
              <TipRow
                color={line.color}
                label={line.label}
                value={
                  line.value === null
                    ? t('noPrice')
                    : kind === 'cost' && grouping !== 'type'
                      ? usd(line.value)
                      : exactCount(line.value)
                }
              />
            )
          })()}
      </ChartTip>
    </section>
  )
}

/** The lines as parts of one ring, from the top clockwise, the hovered one lit. */
function Donut({
  lines,
  total,
  active,
  onPoint,
}: {
  lines: readonly Line[]
  total: number
  active: string | null
  onPoint: (key: string | null, at: DOMRect | null) => void
}) {
  const r = DONUT / 2 - DONUT_STROKE / 2
  const length = 2 * Math.PI * r
  const parts = lines.map((line) => ((line.value ?? 0) / total) * length)
  const starts = parts.map((_, i) => parts.slice(0, i).reduce((sum, part) => sum + part, 0))
  const point = (key: string) => (event: PointerEvent<SVGCircleElement>) =>
    onPoint(key, new DOMRect(event.clientX, event.clientY - 4, 0, 0))
  return (
    <svg
      aria-hidden
      className="k-u-donut"
      width={DONUT}
      height={DONUT}
      viewBox={`0 0 ${DONUT} ${DONUT}`}
      onPointerLeave={() => onPoint(null, null)}
    >
      {lines.map((line, i) => {
        const part = parts[i]!
        const gap = lines.length > 1 && part > 3 ? DONUT_GAP : 0
        if (part <= 0) return null
        return (
          <circle
            key={line.key}
            cx={DONUT / 2}
            cy={DONUT / 2}
            r={r}
            fill="none"
            stroke={line.color}
            strokeWidth={DONUT_STROKE}
            strokeDasharray={`${Math.max(part - gap, 0.6)} ${length}`}
            strokeDashoffset={-starts[i]!}
            transform={`rotate(-90 ${DONUT / 2} ${DONUT / 2})`}
            data-dim={(active !== null && active !== line.key) || undefined}
            onPointerMove={point(line.key)}
          />
        )
      })}
    </svg>
  )
}
