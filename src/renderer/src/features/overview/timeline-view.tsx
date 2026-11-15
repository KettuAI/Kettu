import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { clockTime } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { sessionBars, taskBars, type OverviewRow, type TimelineBar } from './model'
import { RowMark, RowSub, RowTime } from './parts'
import { useRowFacts } from './use-row-facts'

const MINUTE = 60_000
/** The stretch the timeline shows, ending now. */
const SPAN = 120 * MINUTE
const TICK = 30 * MINUTE

/** The ticks on the half hours inside the window, as shares of its width. */
function useTicks(now: number): { at: number; left: string }[] {
  const minute = Math.floor(now / MINUTE)
  return useMemo(() => {
    const end = minute * MINUTE
    const start = end - SPAN
    const ticks: { at: number; left: string }[] = []
    for (let at = Math.ceil(start / TICK) * TICK; at < end; at += TICK) {
      ticks.push({ at, left: `${((at - start) / SPAN) * 100}%` })
    }
    return ticks
  }, [minute])
}

/** The same rows with their steps laid on the last two hours; the right edge is now. */
export function TimelineTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation('overview')
  const ticks = useTicks(useNow())
  return (
    <div className="ui-sg-card k-ov-table">
      <div aria-hidden className="k-ov-tlr k-ov-th">
        <span />
        <span>{t('columns.name')}</span>
        <span className="k-ov-axis">
          {ticks.map((tick) => (
            <em key={tick.at} style={{ left: tick.left }}>
              {clockTime(tick.at)}
            </em>
          ))}
          <em data-now>{t('timeline.now')}</em>
        </span>
        <span />
      </div>
      {children}
    </div>
  )
}

export function TimelineRow({ row, project }: { row: OverviewRow; project: boolean }) {
  const { t } = useTranslation('overview')
  const facts = useRowFacts(row)
  const now = useNow()
  const ticks = useTicks(now)
  const start = now - SPAN
  const bars: TimelineBar[] =
    row.kind === 'task'
      ? taskBars(facts.steps ?? [], now)
      : sessionBars(row.state, row.updatedAt, facts.read, facts.now, now)
  const shown = bars.filter((bar) => bar.to > start)
  return (
    <div className="k-ov-tlr" data-state={row.state}>
      <button type="button" className="k-ov-open" aria-label={facts.title} onClick={facts.open} />
      <span className="k-ov-mark">
        <RowMark row={row} />
      </span>
      <span className="k-ov-name">
        <b>{facts.title}</b>
        <small>
          <RowSub facts={facts} project={project} />
        </small>
      </span>
      <span className="k-ov-track">
        {ticks.map((tick) => (
          <u key={tick.at} style={{ left: tick.left }} />
        ))}
        {shown.length === 0 && <span className="k-ov-earlier">{t('timeline.earlier')}</span>}
        {shown.map((bar) => {
          const from = Math.max(bar.from, start)
          const style: CSSProperties = {
            left: `${((from - start) / SPAN) * 100}%`,
            width: `${(Math.max(bar.to - from, 0) / SPAN) * 100}%`,
          }
          return (
            <span
              key={bar.key}
              className="k-ov-bar"
              data-look={bar.look}
              data-open={bar.open || undefined}
              style={style}
              title={bar.name}
            >
              <span>{bar.name}</span>
            </span>
          )
        })}
      </span>
      <span className="k-ov-end">
        <RowTime row={row} facts={facts} />
      </span>
    </div>
  )
}
