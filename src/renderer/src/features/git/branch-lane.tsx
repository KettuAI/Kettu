import { useTranslation } from 'react-i18next'

/** Commits drawn on the lane before the rest collapse into a gap with their count. */
const MAX_DOTS = 8

/**
 * A small drawing of the branch against its base: the base on top with the commits the branch is
 * behind, the branch below with filled dots for pushed commits, rings for commits not pushed, and
 * a dashed ring at the tip when the working tree has changes.
 */
export function BranchLane({
  base,
  pushed,
  unpushed,
  behind,
  dirty,
  upstream,
}: {
  base: string
  pushed: number
  unpushed: number
  behind: number
  dirty: boolean
  upstream: boolean
}) {
  const { t } = useTranslation('git')
  const total = pushed + unpushed
  const W = 336
  const fork = 34
  const by = 18
  const ly = 52
  const start = 66

  // Collapse long branches: keep the newest commits and show how many were folded away.
  const shownUnpushed = Math.min(unpushed, MAX_DOTS)
  const shownPushed = Math.min(pushed, Math.max(1, MAX_DOTS - shownUnpushed))
  const hidden = total - shownPushed - shownUnpushed
  const slots = shownPushed + shownUnpushed + (hidden > 0 ? 1 : 0) + (dirty ? 1 : 0)
  const step = Math.min(46, (W - 40 - start) / Math.max(1, slots))
  const xs: { x: number; kind: 'pushed' | 'unpushed' | 'gap' }[] = []
  let x = start
  if (hidden > 0 && shownPushed > 0) {
    xs.push({ x, kind: 'gap' })
    x += step
  }
  for (let i = 0; i < shownPushed; i++, x += step) xs.push({ x, kind: 'pushed' })
  for (let i = 0; i < shownUnpushed; i++, x += step) xs.push({ x, kind: 'unpushed' })
  const lastCommit = xs.filter((p) => p.kind !== 'gap').at(-1)?.x ?? fork + 24
  const tip = dirty ? lastCommit + step : lastCommit
  const lastPushed = xs.filter((p) => p.kind === 'pushed').at(-1)?.x ?? null
  const firstUnpushed = xs.find((p) => p.kind === 'unpushed')?.x ?? null
  const baseDots = Array.from(
    { length: Math.min(behind, 4) },
    (_, i) => W - 60 - (Math.min(behind, 4) - 1 - i) * 26,
  )
  const label = [
    t('lane.label.ahead', { count: total, base }),
    upstream && unpushed ? t('lane.label.notPushed', { count: unpushed }) : null,
    behind ? t('lane.label.behind', { count: behind }) : null,
    dirty ? t('lane.label.uncommitted') : null,
  ]
    .filter(Boolean)
    .join(t('lane.label.separator'))

  return (
    <svg
      role="img"
      aria-label={label}
      width="100%"
      height={72}
      viewBox={`0 0 ${W} 72`}
      className="block overflow-visible"
    >
      <text x={0} y={by + 4} className="fill-muted-foreground font-mono text-[11px]">
        {base.length > 6 ? base.slice(0, 5) + '…' : base}
      </text>
      <line
        x1={fork - 6}
        y1={by}
        x2={W - 34}
        y2={by}
        className="stroke-border-strong"
        strokeWidth={1.5}
      />
      <circle cx={fork} cy={by} r={3.5} className="fill-muted-foreground" />
      {baseDots.map((bx) => (
        <circle key={bx} cx={bx} cy={by} r={3.5} className="fill-muted-foreground" />
      ))}
      {behind > 0 && (
        <text x={W - 28} y={by + 4} className="fill-muted-foreground text-[11px] tabular">
          ↓{behind}
        </text>
      )}
      <path
        d={`M${fork} ${by} C ${fork} ${ly - 8}, ${fork + 8} ${ly}, ${fork + 24} ${ly} L ${tip} ${ly}`}
        fill="none"
        className="stroke-border-strong"
        strokeWidth={1.5}
      />
      {dirty && (
        <>
          <line
            x1={lastCommit}
            y1={ly}
            x2={tip}
            y2={ly}
            className="stroke-popover"
            strokeWidth={2}
          />
          <line
            x1={lastCommit + 6}
            y1={ly}
            x2={tip - 6}
            y2={ly}
            className="stroke-border-strong"
            strokeWidth={1.5}
            strokeDasharray="2 3"
          />
        </>
      )}
      {xs.map((p) =>
        p.kind === 'gap' ? (
          <text
            key={p.x}
            x={p.x}
            y={ly + 4}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px] tabular"
          >
            +{hidden}
          </text>
        ) : p.kind === 'pushed' ? (
          <circle key={p.x} cx={p.x} cy={ly} r={4.5} className="fill-foreground" />
        ) : (
          <circle
            key={p.x}
            cx={p.x}
            cy={ly}
            r={4.5}
            className="fill-popover stroke-foreground"
            strokeWidth={1.6}
          />
        ),
      )}
      {dirty && (
        <circle
          cx={tip}
          cy={ly}
          r={4.5}
          className="fill-popover stroke-muted-foreground"
          strokeWidth={1.4}
          strokeDasharray="2 2"
        />
      )}
      {upstream && lastPushed !== null && (
        <>
          <line
            x1={lastPushed}
            y1={ly - 9}
            x2={lastPushed}
            y2={ly - 15}
            className="stroke-muted-foreground"
            strokeWidth={1.2}
          />
          <text
            x={lastPushed}
            y={ly - 19}
            textAnchor="middle"
            className="fill-muted-foreground font-mono text-[10px]"
          >
            origin
          </text>
        </>
      )}
      {pushed > 0 && (
        <text
          x={xs.find((p) => p.kind === 'pushed')?.x ?? start}
          y={ly + 19}
          className="fill-muted-foreground text-[11px]"
        >
          {t('lane.pushed', { count: pushed })}
        </text>
      )}
      {firstUnpushed !== null && (
        <text x={firstUnpushed} y={ly + 19} className="fill-foreground text-[11px] font-medium">
          {upstream
            ? t('lane.notPushed', { count: unpushed })
            : t('lane.notPublished', { count: unpushed })}
        </text>
      )}
      {dirty && (
        <text x={tip} y={ly - 13} textAnchor="middle" className="fill-muted-foreground text-[11px]">
          {t('lane.changes')}
        </text>
      )}
    </svg>
  )
}
