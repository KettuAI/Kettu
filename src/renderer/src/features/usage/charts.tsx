import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { AgentId } from '@shared/thread'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  addDays,
  axisLabels,
  barGap,
  BAR_WIDTH,
  heatLevels,
  type DayRange,
  type TrendBar,
} from './model'
import { useAgentColor } from './series'

const HEAT_FILL = ['bg-heat-0', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4'] as const
/** A day outside the range: its step in gray, so the shades still compare. */
const HEAT_OUT = [
  'bg-heat-0',
  'bg-heat-out-1',
  'bg-heat-out-2',
  'bg-heat-out-3',
  'bg-heat-out-4',
] as const
/** The heatmap's cells: seven rows as tall as the squares they hold. */
const HEAT_CELLS = 'grid-rows-[repeat(7,auto)]'
/** The weekday labels: seven rows sharing the cells' height, adding none of their own. */
const HEAT_LABELS = 'grid-rows-[repeat(7,minmax(0,1fr))] contain-size'
/** A heatmap cell is at most 14 px, and shrinks with the card. */
const HEAT_CELL = 14

/** The chosen bar or day: the fox ring, clear of it by a line of the card. */
const BAR_OUTLINE = 'shadow-[0_0_0_2px_var(--bg-surface),0_0_0_3.5px_var(--focus)]'
const CELL_OUTLINE = 'shadow-[0_0_0_1.5px_var(--bg-surface),0_0_0_3px_var(--focus)]'

/**
 * The trend's grid under the bars: a line atop each quarter, then the baseline. Borders, since an
 * inset shadow for the baseline leaves faint side lines when the chart sits between pixels.
 */
const GRID_ROWS = [
  'border-t border-subtle',
  'border-t border-subtle',
  'border-t border-subtle',
  'border-y border-subtle border-b-default',
] as const

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

/** Whether focus came from the keyboard, which then picks a bar or day to start from. */
function keyboardFocus(event: FocusEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')
}

/**
 * The range's amounts as bars, stacked by agent and scaled to `max`, over grid lines and a
 * baseline. A bar chosen with the pointer or the arrow keys takes the fox ring and a tooltip
 * beside it; the keys start from the busiest one.
 */
export function TrendChart({
  bars,
  series,
  max,
  start,
  chosen,
  label,
  future = 0,
  tooltip,
  onChoose,
}: {
  bars: TrendBar[]
  /** The series to stack, bottom first. */
  series: readonly AgentId[]
  /** The tallest bar's amount from those series: the top of the scale. */
  max: number
  /** The bar the arrow keys start from. */
  start: number | null
  chosen: number | null
  label: string
  /** How many of the last bars are still to come: dimmed, and never chosen. */
  future?: number
  /** What the chosen bar's tooltip says. */
  tooltip: (index: number) => ReactNode
  onChoose: (index: number | null) => void
}) {
  const begun = bars.length - future
  const color = useAgentColor()
  const row = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    const el = row.current
    const bar = chosen === null ? null : el?.querySelector<HTMLElement>(`[data-bar="${chosen}"]`)
    if (!el || !bar) return setPlace(null)
    // Beside the bar, on the side with more room, so it never leaves the chart.
    const width = el.offsetWidth
    const left = bar.offsetLeft
    setPlace(
      left + bar.offsetWidth / 2 <= width / 2
        ? { left: left + bar.offsetWidth + 8 }
        : { right: width - left + 8 },
    )
  }, [chosen, bars])

  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-rows-4">
        {GRID_ROWS.map((line, i) => (
          <span key={i} className={line} />
        ))}
      </div>
      <div
        ref={row}
        role="group"
        tabIndex={0}
        aria-label={label}
        className="relative flex h-45 items-end justify-center rounded-xs outline-none focus-ring"
        style={{ gap: barGap(bars.length) }}
        onPointerLeave={() => onChoose(null)}
        onFocus={(event) => {
          if (keyboardFocus(event) && begun > 0) onChoose(Math.min(start ?? begun - 1, begun - 1))
        }}
        onBlur={() => onChoose(null)}
        onKeyDown={(event) => {
          const next = begun > 0 ? moveIndex(event, chosen ?? start ?? 0, begun, 1, 0) : null
          if (next !== null) onChoose(next)
        }}
      >
        {bars.map((bar, i) => {
          const parts = series.filter((id) => (bar.byAgent[id] ?? 0) > 0)
          const total = parts.reduce((sum, id) => sum + bar.byAgent[id]!, 0)
          return (
            <div
              key={bar.from}
              data-bar={i}
              className={cn('flex h-full min-w-0 flex-1 items-end', i >= begun && 'opacity-35')}
              // A few days stay bars, not blocks across the chart; the dates are placed by it too.
              style={{ maxWidth: BAR_WIDTH }}
              onPointerEnter={i < begun ? () => onChoose(i) : undefined}
            >
              {parts.length > 0 && (
                <div
                  className={cn(
                    'flex w-full flex-col-reverse overflow-hidden rounded-t-sm',
                    chosen === i && BAR_OUTLINE,
                  )}
                  // Each part keeps a pixel, so usage too small for one still shows.
                  style={{ height: `${(total / max) * 100}%`, minHeight: parts.length }}
                >
                  {parts.map((agentId, k) => (
                    <span
                      key={agentId}
                      className={cn(
                        'min-h-px basis-0',
                        k > 0 && 'shadow-[inset_0_calc(-1*var(--hairline))_0_var(--bg-surface)]',
                      )}
                      style={{ flexGrow: bar.byAgent[agentId], backgroundColor: color(agentId) }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {chosen !== null && place && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-1 z-10 flex min-w-37.5 flex-col gap-1 rounded-xl bg-popover px-2.5 py-2 text-small text-secondary shadow-menu"
          style={place}
        >
          {tooltip(chosen)}
        </div>
      )}
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
    <div
      ref={row}
      aria-hidden
      className="relative mt-2 h-4 text-caption text-tertiary tabular-nums"
    >
      {labels.map((l) => (
        <span key={l.index} className="absolute top-0 whitespace-nowrap" style={{ left: l.left }}>
          {l.text}
        </span>
      ))}
    </div>
  )
})

/** The trend's series as toggle buttons that show or hide each one, the last one shown staying. */
export const TrendLegend = memo(function TrendLegend({
  series,
  shown,
  label,
  keepOne,
  onChange,
}: {
  series: readonly AgentId[]
  shown: readonly AgentId[]
  label: string
  /** Why the last key shown stays pressed, in its tooltip. */
  keepOne: string
  onChange: (shown: AgentId[]) => void
}) {
  const color = useAgentColor()
  return (
    <ToggleGroup
      multiple
      value={shown}
      onValueChange={(next) => onChange(next as AgentId[])}
      aria-label={label}
      variant="legend"
      className="-mr-1.5 min-w-0 flex-wrap gap-0.5"
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
                    'h-6 min-w-0 gap-1.5 rounded-md px-1.5 text-hint text-tertiary aria-pressed:text-secondary aria-pressed:hover:text-foreground',
                    last && 'cursor-default hover:bg-transparent aria-pressed:hover:bg-transparent',
                  )}
                />
              }
            >
              <span
                aria-hidden
                className={cn(
                  'size-2 rounded-xs',
                  !on && 'shadow-[inset_0_0_0_1.5px_var(--border-strong)]',
                )}
                style={on ? { backgroundColor: color(id) } : undefined}
              />
              {agentName(id)}
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
            'aspect-square self-center rounded-md',
            (outside[i] ? HEAT_OUT : HEAT_FILL)[level],
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
 * 53 weeks of days, a column per week starting on the locale's first day, a row per weekday. The
 * shade is the day's quartile among the days with usage. One pointer listener and the arrow keys
 * pick a day, which takes the fox ring and a tooltip; only those move, so the 371 cells never
 * re-render on hover.
 */
export function Heatmap({
  days,
  values,
  range,
  label,
  monthLabel,
  weekdayLabel,
  tip,
  spoken,
}: {
  /** The heatmap's day starts, oldest first, starting on the first day of a week. */
  days: readonly number[]
  /** Each day's amount, which shades it. */
  values: readonly number[]
  range: DayRange
  label: string
  monthLabel: (day: number) => string
  weekdayLabel: (day: number) => string
  /** The chosen day's tooltip. */
  tip: (index: number) => string
  /** The chosen day for screen readers. */
  spoken: (index: number) => string
}) {
  const grid = useRef<HTMLDivElement>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; size: number; column: number } | null>(
    null,
  )
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
  const future = (7 - (days.length % 7)) % 7
  const columns = Math.ceil(days.length / 7)

  useLayoutEffect(() => {
    const cell =
      chosen === null ? null : grid.current?.querySelector<HTMLElement>(`[data-i="${chosen}"]`)
    setBox(
      chosen !== null && cell
        ? {
            x: cell.offsetLeft,
            y: cell.offsetTop,
            size: cell.offsetWidth,
            column: Math.floor(chosen / 7),
          }
        : null,
    )
  }, [chosen, days])

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
  const template = { gridTemplateColumns: `repeat(${columns}, minmax(0, ${HEAT_CELL}px))` }
  // The tooltip starts at its day near the left edge, ends at it near the right, else centres.
  const align = !box ? 0 : box.column < 4 ? 0 : box.column >= columns - 4 ? 1 : 0.5

  return (
    <div className="grid grid-cols-[--spacing(6)_minmax(0,1fr)] gap-x-2 gap-y-1.5">
      <span />
      <div
        aria-hidden
        className="grid h-3.5 gap-x-0.75 text-[11px] leading-3.5 text-tertiary"
        style={template}
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
      <div aria-hidden className={cn('grid gap-y-0.75 text-[10.5px] text-tertiary', HEAT_LABELS)}>
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
          'relative grid w-fit grid-flow-col gap-0.75 rounded-xs outline-none focus-ring',
          HEAT_CELLS,
        )}
        style={template}
        onPointerOver={(event) => {
          const index = (event.target as HTMLElement).dataset.i
          if (index !== undefined) setChosen(Number(index))
        }}
        onPointerLeave={() => setChosen(null)}
        onFocus={(event) => {
          if (keyboardFocus(event) && days.length > 0) setChosen(busiest)
        }}
        onBlur={() => setChosen(null)}
        onKeyDown={(event) => {
          // The columns are weeks: left and right move a week, up and down a day.
          const next = moveIndex(event, chosen ?? busiest, days.length, 7, 1)
          if (next !== null) setChosen(next)
        }}
      >
        <Cells levels={levels} outside={outside} future={future} />
        {box && chosen !== null && (
          <>
            <span
              aria-hidden
              className={cn('pointer-events-none absolute top-0 left-0 rounded-md', CELL_OUTLINE)}
              style={{
                width: box.size,
                height: box.size,
                transform: `translate(${box.x}px, ${box.y}px)`,
              }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute z-10 rounded-tile bg-foreground px-2 py-1.25 text-caption whitespace-nowrap text-background"
              style={{
                left: box.x + box.size * align,
                top: box.y,
                transform: `translate(${-align * 100}%, calc(-100% - 6px))`,
              }}
            >
              {tip(chosen)}
            </span>
          </>
        )}
      </div>
      <span role="status" className="sr-only">
        {chosen !== null ? spoken(chosen) : ''}
      </span>
    </div>
  )
}

/** The heatmap's scale, from none to the top quartile. */
export function HeatLegend({ less, more }: { less: string; more: string }) {
  return (
    <span className="flex items-center gap-1 text-caption text-tertiary">
      <span className="mr-0.5">{less}</span>
      {HEAT_FILL.map((fill) => (
        <span key={fill} aria-hidden className={cn('size-2.75 rounded-sm', fill)} />
      ))}
      <span className="ml-0.5">{more}</span>
    </span>
  )
}
