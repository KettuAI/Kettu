import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  addDays,
  agentFill,
  axisLabels,
  barGap,
  BAR_WIDTH,
  heatLevels,
  widest,
  type DayRange,
  type TrendBar,
} from './model'

const HEAT_FILL = ['bg-heat-0', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4'] as const
/** The heatmap's cells: seven rows as tall as the squares they hold. */
const HEAT_CELLS = 'grid-rows-[repeat(7,auto)]'
/** The weekday labels: seven rows sharing the cells' height, adding none of their own. */
const HEAT_LABELS = 'grid-rows-[repeat(7,minmax(0,1fr))] contain-size'

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
 * The range's amounts as bars, stacked by agent and scaled to `max`, on a baseline and under a grid
 * line at `max`. A bar chosen with the pointer or the arrow keys dims the others; the keys start
 * from the shown one.
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
  /** The tallest bar's amount from those series: the top of the scale. */
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
    <div className="relative flex min-h-49 flex-1 flex-col shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-default)]">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-strong"
      />
      <div
        role="group"
        tabIndex={0}
        aria-label={label}
        className="relative flex flex-1 items-end justify-center rounded-md outline-none focus-ring"
        style={{ gap: barGap(bars.length) }}
        onPointerLeave={() => onChoose(null)}
        onBlur={() => onChoose(null)}
        onKeyDown={(event) => {
          const next = begun > 0 ? moveIndex(event, shown ?? 0, begun, 1, 0) : null
          if (next !== null) onChoose(next)
        }}
      >
        {bars.map((bar, i) => {
          const parts = series.filter((id) => (bar.byAgent[id] ?? 0) > 0)
          const total = parts.reduce((sum, id) => sum + bar.byAgent[id]!, 0)
          return (
            <div
              key={bar.from}
              className={cn(
                'flex h-full min-w-0 flex-1 items-end transition-opacity duration-(--duration-fast)',
                chosen !== null && chosen !== i && 'opacity-40',
                i >= begun && 'opacity-35',
              )}
              // A few days stay bars, not blocks across the chart; the dates are placed by it too.
              style={{ maxWidth: BAR_WIDTH }}
              onPointerEnter={i < begun ? () => onChoose(i) : undefined}
            >
              {parts.length > 0 && (
                <div
                  className="flex w-full flex-col-reverse overflow-hidden rounded-t-xs"
                  // Each part keeps a pixel, so usage too small for one still shows.
                  style={{ height: `${(total / max) * 100}%`, minHeight: parts.length }}
                >
                  {parts.map((agentId, k) => (
                    <span
                      key={agentId}
                      className={cn(
                        'min-h-px basis-0',
                        k > 0 && 'shadow-[inset_0_calc(-1*var(--hairline))_0_var(--bg-surface)]',
                        agentFill(agentId),
                      )}
                      style={{ flexGrow: bar.byAgent[agentId] }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** An agent's part of a bar; "—" for none, as the page writes a figure with nothing in it. */
function partValue(value: number | undefined, format: (value: number) => string): string {
  return value ? format(value) : '—'
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
  pick,
  text,
}: {
  count: number
  anchor: 'start' | 'end'
  steps?: readonly number[]
  pick?: (step: number) => number[]
  text: (index: number, previous: number | null) => string
}) {
  const row = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ width: number; font: string } | null>(null)
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const read = () => {
      const style = getComputedStyle(el)
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const width = parseFloat(style.width)
      setBox((b) => (b && b.width === width && b.font === font ? b : { width, font }))
    }
    // Read before the first paint, so the dates come with the bars, then on every resize.
    read()
    const observer = new ResizeObserver(read)
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
    const width = box.width
    return axisLabels({ count, width, anchor, steps, pick, gap: LABEL_GAP, text, measure })
  }, [box, count, anchor, steps, pick, text])
  return (
    <div ref={row} aria-hidden className="relative mt-1.5 h-5 text-meta text-tertiary tabular-nums">
      {labels.map((l) => (
        <span key={l.index} className="absolute top-0 whitespace-nowrap" style={{ left: l.left }}>
          {l.text}
        </span>
      ))}
    </div>
  )
})

/**
 * The trend's series as toggle buttons that show or hide each one, the last one shown staying,
 * each with its amount in the bar the header names. A value keeps the room of the widest it takes
 * in any bar, so moving along the bars never moves a key.
 */
export const TrendLegend = memo(function TrendLegend({
  bars,
  index,
  series,
  shown,
  label,
  keepOne,
  formatValue,
  onChange,
}: {
  bars: TrendBar[]
  index: number | null
  series: readonly AgentId[]
  shown: readonly AgentId[]
  label: string
  /** Why the last key shown stays pressed, in its tooltip. */
  keepOne: string
  formatValue: (value: number) => string
  onChange: (shown: AgentId[]) => void
}) {
  const { i18n } = useTranslation()
  const room = useMemo(
    () => {
      const font = `500 12.5px ${getComputedStyle(document.body).fontFamily}`
      const values = (id: AgentId) => bars.map((bar) => partValue(bar.byAgent[id], formatValue))
      return new Map(series.map((id) => [id, widest(values(id), (t) => textWidth(t, font))]))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the formatters follow the language
    [bars, series, i18n.language, formatValue],
  )
  const bar = index === null ? null : bars[index]
  return (
    <ToggleGroup
      multiple
      value={shown}
      onValueChange={(next) => onChange(next as AgentId[])}
      aria-label={label}
      variant="legend"
      className="min-w-0 flex-1 flex-wrap gap-x-2.5 gap-y-0.5"
    >
      {series.map((id) => {
        const on = shown.includes(id)
        const last = on && shown.length === 1
        return (
          <Tooltip key={id} disabled={!last}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value={id}
                  className={cn(
                    'h-6 min-w-0 gap-1.5 rounded-md px-1.5 text-command text-tertiary aria-pressed:text-secondary aria-pressed:hover:text-foreground',
                    last && 'cursor-default hover:bg-transparent aria-pressed:hover:bg-transparent',
                  )}
                />
              }
            >
              <span
                aria-hidden
                className={cn(
                  'size-2.25 rounded-xs',
                  on ? agentFill(id) : 'shadow-[inset_0_0_0_1.5px_var(--border-strong)]',
                )}
              />
              {agentName(id)}
              {/* The header reads the values out; the button's name stays the agent's. */}
              <span
                aria-hidden
                className={cn(
                  'grid text-left font-medium tabular-nums',
                  on ? 'text-foreground' : 'text-tertiary',
                )}
              >
                <span className="invisible col-start-1 row-start-1">{room.get(id)}</span>
                <span className="col-start-1 row-start-1">
                  {bar && partValue(bar.byAgent[id], formatValue)}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{keepOne}</TooltipContent>
          </Tooltip>
        )
      })}
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
          className={cn(
            'aspect-square self-center rounded-xs',
            HEAT_FILL[level],
            outside[i] && 'opacity-35',
          )}
        />
      ))}
      {Array.from({ length: future }, (_, i) => (
        <span key={`f${i}`} aria-hidden />
      ))}
    </>
  )
})

/** Monday, Wednesday and Friday, as GitHub labels its contribution graph, whatever the week's start. */
const LABELLED_WEEKDAYS = new Set([1, 3, 5])

/**
 * 53 weeks of days, a column per week starting on the locale's first day, a row per weekday as
 * tall as its label. The shade is the day's quartile among the days with usage. One pointer
 * listener and the arrow keys pick a day; only the outline moves, so the 371 cells never
 * re-render on hover.
 */
export function Heatmap({
  days,
  values,
  range,
  label,
  monthLabel,
  weekdayLabel,
  onShow,
}: {
  /** The heatmap's day starts, oldest first, starting on the first day of a week. */
  days: readonly number[]
  /** Each day's amount, which shades it. */
  values: readonly number[]
  range: DayRange
  label: string
  monthLabel: (day: number) => string
  weekdayLabel: (day: number) => string
  /** The day the header names: the one chosen, else the busiest in the range. */
  onShow: (index: number | null) => void
}) {
  const grid = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; size: number } | null>(null)
  const levels = useMemo(() => heatLevels(values), [values])
  const outside = useMemo(() => days.map((d) => d < range.from || d >= range.to), [days, range])
  const busiest = useMemo(
    () =>
      values.reduce(
        (best, value, i) => (!outside[i] && value > (values[best] ?? 0) ? i : best),
        days.length - 1,
      ),
    [values, days.length, outside],
  )
  const shown = chosen ?? busiest
  const future = (7 - (days.length % 7)) % 7
  const columns = Math.ceil(days.length / 7)

  useLayoutEffect(() => {
    onShow(days.length > 0 ? shown : null)
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
        if (day !== undefined && new Date(day).getDate() === 1) {
          labels.push({ column, text: monthLabel(day) })
          break
        }
      }
    }
    return labels
  }, [days, columns, monthLabel])
  const weekStart = days[0] ?? 0
  const template = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }

  return (
    <div className="grid grid-cols-[--spacing(7.5)_minmax(0,1fr)] gap-x-1.5">
      <span />
      <div aria-hidden className="grid h-4.5 text-meta text-tertiary" style={template}>
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
      <div aria-hidden className={cn('grid gap-y-0.75 text-meta text-tertiary', HEAT_LABELS)}>
        {[0, 1, 2, 3, 4, 5, 6].map((row) => {
          const day = addDays(weekStart, row)
          return (
            <span key={row} className="flex items-center">
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
        className={cn(
          'relative grid grid-flow-col gap-0.75 rounded-xs outline-none focus-ring',
          HEAT_CELLS,
        )}
        style={template}
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
            className="pointer-events-none absolute top-0 left-0 rounded-xs ring-[1.5px] ring-foreground"
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
    <span className="flex items-center gap-1 text-meta text-tertiary">
      <span className="mx-0.75">{less}</span>
      {HEAT_FILL.map((fill) => (
        <span key={fill} aria-hidden className={cn('size-2.75 rounded-xs', fill)} />
      ))}
      <span className="mx-0.75">{more}</span>
    </span>
  )
}
