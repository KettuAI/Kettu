import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentId } from '@shared/thread'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  addDays,
  AGENT_FILL,
  axisLabels,
  heatLevels,
  type DayRange,
  type DayTotal,
  type TrendBar,
} from './model'

const HEAT_FILL = ['bg-heat-0', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4'] as const

/** Where the arrow keys, Home and End take an index; `vertical` is how far up and down go. */
function moveIndex(
  event: KeyboardEvent,
  index: number,
  count: number,
  horizontal: number,
  vertical: number,
): number | null {
  const steps: Record<string, number> = {
    ArrowLeft: -horizontal,
    ArrowRight: horizontal,
    ArrowUp: -vertical,
    ArrowDown: vertical,
  }
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? count - 1
        : event.key in steps
          ? index + steps[event.key]!
          : null
  if (next === null) return null
  event.preventDefault()
  return Math.min(count - 1, Math.max(0, next))
}

/**
 * The range's tokens as bars, stacked by agent and scaled to `max`, under a grid line at it. A bar
 * chosen with the pointer or the arrow keys dims the others; the keys start from the shown one.
 */
export function TrendChart({
  bars,
  series,
  max,
  shown,
  chosen,
  label,
  future = 0,
  onChoose,
}: {
  bars: TrendBar[]
  /** The series to stack, bottom first. */
  series: readonly AgentId[]
  /** The tallest bar's tokens from those series: the top of the scale. */
  max: number
  /** The bar the header names. */
  shown: number | null
  chosen: number | null
  label: string
  /** How many of the last bars are still to come: dimmed, and never chosen. */
  future?: number
  onChoose: (index: number | null) => void
}) {
  const begun = bars.length - future
  return (
    <div className="relative h-40">
      <span aria-hidden className="absolute inset-x-0 top-0 border-t border-dashed border-default" />
      <div
        role="group"
        tabIndex={0}
        aria-label={label}
        className="relative flex h-full items-end justify-center gap-px rounded-md outline-none focus-ring"
        onPointerLeave={() => onChoose(null)}
        onBlur={() => onChoose(null)}
        onKeyDown={(event) => {
          const next = begun > 0 ? moveIndex(event, shown ?? 0, begun, 1, 0) : null
          if (next !== null) onChoose(next)
        }}
      >
        {bars.map((bar, i) => {
          const parts = series.filter((id) => (bar.byAgent[id] ?? 0) > 0)
          return (
            <div
              key={bar.from}
              className={cn(
                // A few days stay bars, not blocks across the chart.
                'flex h-full max-w-12 min-w-0 flex-1 flex-col-reverse rounded-t-xs transition-opacity duration-(--duration-fast)',
                chosen !== null && chosen !== i && 'opacity-60',
                i >= begun && 'opacity-35',
              )}
              onPointerEnter={i < begun ? () => onChoose(i) : undefined}
            >
              {parts.length === 0 ? (
                <span className="h-px w-full bg-heat-0" />
              ) : (
                parts.map((agentId) => (
                  <span
                    key={agentId}
                    className={cn(
                      // Usage too small for a pixel still shows, apart from a day without any.
                      'min-h-px w-full first:rounded-b-none last:rounded-t-xs',
                      AGENT_FILL[agentId],
                    )}
                    style={{ height: `${(bar.byAgent[agentId]! / max) * 100}%` }}
                  />
                ))
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Room between two dates under the trend, the 12 px spacing step. */
const LABEL_GAP = 12

let canvas: CanvasRenderingContext2D | null = null

/** A label's width in `font`, its digits as wide as the widest, as tabular figures are. */
function textWidth(text: string, font: string): number {
  canvas ??= document.createElement('canvas').getContext('2d')!
  canvas.font = font
  return canvas.measureText(text.replace(/\d/g, '0')).width
}

/** Dates under the trend's bars, evenly spaced, as many as fit apart in the row's own font. */
export const TrendAxis = memo(function TrendAxis({
  count,
  anchor,
  steps,
  text,
}: {
  count: number
  anchor: 'start' | 'end'
  steps?: readonly number[]
  text: (index: number, previous: number | null) => string
}) {
  const row = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ width: number; font: string } | null>(null)
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const style = getComputedStyle(el)
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const width = entry!.contentRect.width
      setBox((b) => (b && b.width === width && b.font === font ? b : { width, font }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const labels = useMemo(() => {
    if (!box) return []
    const widths = new Map<string, number>()
    const measure = (label: string) => {
      let width = widths.get(label)
      if (width === undefined) {
        width = textWidth(label, box.font)
        widths.set(label, width)
      }
      return width
    }
    return axisLabels({ count, width: box.width, anchor, steps, gap: LABEL_GAP, text, measure })
  }, [box, count, anchor, steps, text])
  return (
    <div ref={row} aria-hidden className="relative h-4 text-xs text-tertiary tabular-nums">
      {labels.map((l) => (
        <span key={l.index} className="absolute top-0 whitespace-nowrap" style={{ left: l.left }}>
          {l.text}
        </span>
      ))}
    </div>
  )
})

/** The trend's series as toggle buttons that show or hide each one; the last one shown stays. */
export const TrendLegend = memo(function TrendLegend({
  series,
  shown,
  label,
  onChange,
}: {
  series: readonly AgentId[]
  shown: readonly AgentId[]
  label: string
  onChange: (shown: AgentId[]) => void
}) {
  return (
    <ToggleGroup
      multiple
      value={shown}
      onValueChange={(next) => onChange(next as AgentId[])}
      aria-label={label}
      variant="legend"
      size="legend"
      spacing={1}
      className="-ml-1.5 flex-wrap"
    >
      {series.map((id) => (
        <ToggleGroupItem key={id} value={id}>
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-xs',
              shown.includes(id) ? AGENT_FILL[id] : 'ring-1 ring-border-strong ring-inset',
            )}
          />
          {agentName(id)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
})

const Cells = memo(function Cells({
  levels,
  outside,
  future,
}: {
  levels: number[]
  outside: boolean[]
  future: number
}) {
  return (
    <>
      {levels.map((level, i) => (
        <span
          key={i}
          data-i={i}
          className={cn('aspect-square rounded-xs', HEAT_FILL[level], outside[i] && 'opacity-35')}
        />
      ))}
      {Array.from({ length: future }, (_, i) => (
        <span key={`f${i}`} aria-hidden />
      ))}
    </>
  )
})

/**
 * 53 weeks of days, a column per week starting on the locale's first day. The shade is the day's
 * quartile among the days with usage. One pointer listener and the arrow keys pick a day; only
 * the outline moves, so the 371 cells never re-render on hover.
 */
/** Monday, Wednesday and Friday, as GitHub labels its contribution graph, whatever the week's start. */
const LABELLED_WEEKDAYS = new Set([1, 3, 5])

export function Heatmap({
  days,
  range,
  label,
  monthLabel,
  weekdayLabel,
  onShow,
}: {
  /** The heatmap's days, oldest first, starting on the first day of a week. */
  days: DayTotal[]
  range: DayRange
  label: string
  monthLabel: (day: number) => string
  weekdayLabel: (day: number) => string
  onShow: (day: DayTotal | null) => void
}) {
  const grid = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; size: number } | null>(null)
  const levels = useMemo(() => heatLevels(days.map((d) => d.total)), [days])
  const outside = useMemo(
    () => days.map((d) => d.day < range.from || d.day >= range.to),
    [days, range],
  )
  const busiest = useMemo(
    () =>
      days.reduce(
        (best, d, i) => (!outside[i] && d.total > (days[best]?.total ?? 0) ? i : best),
        days.length - 1,
      ),
    [days, outside],
  )
  const shown = chosen ?? busiest
  const future = (7 - (days.length % 7)) % 7
  const columns = Math.ceil(days.length / 7)

  useLayoutEffect(() => {
    onShow(days[shown] ?? null)
    const cell = grid.current?.querySelector<HTMLElement>(`[data-i="${shown}"]`)
    setBox(
      chosen !== null && cell
        ? { x: cell.offsetLeft, y: cell.offsetTop, size: cell.offsetWidth }
        : null,
    )
  }, [shown, chosen, days, onShow])

  const months = useMemo(() => {
    const labels: { column: number; text: string }[] = []
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < 7; row++) {
        const day = days[column * 7 + row]
        if (day && new Date(day.day).getDate() === 1) {
          labels.push({ column, text: monthLabel(day.day) })
          break
        }
      }
    }
    return labels
  }, [days, columns, monthLabel])
  const weekStart = days[0]?.day ?? 0

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
      <span />
      <div
        className="grid text-xs tabular-nums text-tertiary"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {months.map((m) => (
          <span
            key={m.column}
            className="whitespace-nowrap"
            style={{ gridColumnStart: m.column + 1 }}
          >
            {m.text}
          </span>
        ))}
      </div>
      <div className="grid grid-rows-7 text-xs tabular-nums text-tertiary" aria-hidden>
        {[0, 1, 2, 3, 4, 5, 6].map((row) => {
          const day = addDays(weekStart, row)
          return (
            <span key={row} className="flex items-center leading-none">
              {LABELLED_WEEKDAYS.has(new Date(day).getDay()) ? weekdayLabel(day) : ''}
            </span>
          )
        })}
      </div>
      <div
        ref={grid}
        role="group"
        tabIndex={0}
        aria-label={label}
        className="relative grid grid-flow-col grid-rows-7 gap-0.5 rounded-xs outline-none focus-ring"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        onPointerOver={(event) => {
          const index = (event.target as HTMLElement).dataset.i
          if (index !== undefined) setChosen(Number(index))
        }}
        onPointerLeave={() => setChosen(null)}
        onBlur={() => setChosen(null)}
        onKeyDown={(event) => {
          // The columns are weeks: left and right move a week, up and down a day.
          const next = moveIndex(event, shown, days.length, 7, 1)
          if (next !== null) setChosen(next)
        }}
      >
        <Cells levels={levels} outside={outside} future={future} />
        {box && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 rounded-xs ring-1 ring-foreground"
            style={{
              width: box.size,
              height: box.size,
              transform: `translate(${box.x}px, ${box.y}px)`,
            }}
          />
        )}
      </div>
    </div>
  )
}

/** The heatmap's scale, from none to the top quartile. */
export function HeatLegend({ less, more }: { less: string; more: string }) {
  return (
    <span className="flex items-center gap-1 text-xs tabular-nums text-tertiary">
      {less}
      {HEAT_FILL.map((fill) => (
        <span key={fill} aria-hidden className={cn('size-2.5 rounded-xs', fill)} />
      ))}
      {more}
    </span>
  )
}
