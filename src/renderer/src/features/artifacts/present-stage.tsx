import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ArrowLeft01Icon, ArrowRight01Icon, GridViewIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PageKey } from '@shared/artifact-runtime/page-messages'
import { Icon } from '@renderer/components/affect/app-shell'
import { Dialog, DialogPortal, DialogTitle } from '@renderer/components/ui/dialog'
import { Kbd } from '@renderer/components/ui/kbd'
import { cn } from '@renderer/lib/utils'
import type { FitMode } from '@renderer/stores/artifact-viewer'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { FitMenu } from './fit-menu'
import { PositionBar } from './position-bar'
import { readingFit, type Reading } from './reading'
import './present-stage.css'

/** One thing presented at a time: a canvas's frame, or a deck's slide. */
export interface PresentSheet {
  key: string
  width: number
  height: number
  name: string
  /** What it belongs to, such as a canvas's page; the count runs within it. */
  group: string
  /** Empty for the one group of a deck. */
  groupName: string
}

/** Around a sheet: room beside it, above it, and below it for the bar. */
const SIDE = 48
const TOP = 32
const BOTTOM = 80
/** The bar hides after this long without the pointer or a key. */
const IDLE_MS = 2500
/** How far Space and Page Down scroll a long sheet, as a share of the room. */
const PAGE_STEP = 0.8

interface Layer {
  key: string
  n: number
  /** The side it comes in from, or goes out to: 1 the next, -1 the previous, 0 a jump. */
  dir: number
  out?: boolean
}

/**
 * Presenting over the whole window without the viewer's shell: one sheet at a time at reading
 * size, a long one scrolling from its top, stepping with the arrows across groups, and G for a
 * grid of the group's sheets. It knows nothing of what a sheet is: `renderSheet` draws it at its
 * own size, live, and hands the keys its page passes on to `onKey`; `renderThumb` draws its
 * picture in the grid.
 */
export function PresentStage({
  title,
  sheets,
  start,
  renderSheet,
  renderThumb,
  onExit,
}: {
  title: string
  sheets: readonly PresentSheet[]
  start: string
  renderSheet: (sheet: PresentSheet, onKey: (key: PageKey) => void) => ReactNode
  renderThumb: (sheet: PresentSheet) => ReactNode
  onExit: (last: string) => void
}) {
  const { t } = useTranslation('artifacts')
  const [current, setCurrent] = useState(() =>
    sheets.some((s) => s.key === start) ? start : (sheets[0]?.key ?? ''),
  )
  const [layers, setLayers] = useState<Layer[]>([{ key: current, n: 0, dir: 0 }])
  const [fit, setFit] = useState<FitMode>('auto')
  const [grid, setGrid] = useState(false)
  const [gridGroup, setGridGroup] = useState<string | null>(null)
  const [bar, setBar] = useState(true)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const scrollers = useRef(new Map<number, HTMLDivElement>())
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const counter = useRef(0)

  const index = sheets.findIndex((s) => s.key === current)
  const sheet = sheets[index] ?? null
  const group = sheet ? sheets.filter((s) => s.group === sheet.group) : []
  const inGroup = sheet ? group.indexOf(sheet) : -1

  useLayoutEffect(() => {
    if (!stageEl) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(stageEl)
    return () => observer.disconnect()
  }, [stageEl])

  const wake = useCallback(() => {
    setBar(true)
    clearTimeout(idle.current)
    idle.current = setTimeout(() => setBar(false), IDLE_MS)
  }, [])
  useEffect(() => {
    idle.current = setTimeout(() => setBar(false), IDLE_MS)
    return () => clearTimeout(idle.current)
  }, [])

  const go = useCallback(
    (key: string, dir: number) => {
      if (key === current) return
      const n = ++counter.current
      setCurrent(key)
      if (prefersReducedMotion()) {
        setLayers([{ key, n, dir: 0 }])
        return
      }
      setLayers((was) => [
        ...was.filter((l) => !l.out).map((l) => ({ ...l, out: true, dir })),
        { key, n, dir },
      ])
    },
    [current],
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      const next = sheets[index + dir]
      if (next) go(next.key, dir)
    },
    [sheets, index, go],
  )

  const registerScroller = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) scrollers.current.set(n, el)
    else scrollers.current.delete(n)
  }, [])

  const scroller = () => {
    const top = layers.filter((l) => !l.out).at(-1)
    return top ? (scrollers.current.get(top.n) ?? null) : null
  }
  const scrollBy = (dir: 1 | -1): boolean => {
    const el = scroller()
    if (!el || !size) return false
    const before = el.scrollTop
    const end = el.scrollHeight - el.clientHeight
    if ((dir > 0 && before >= end - 1) || (dir < 0 && before <= 0)) return false
    el.scrollBy({
      top: dir * (size.height - TOP - BOTTOM) * PAGE_STEP,
      behavior: prefersReducedMotion() ? 'instant' : 'smooth',
    })
    return true
  }

  const toggleGrid = () => {
    if (!grid) setGridGroup(sheet?.group ?? null)
    setGrid(!grid)
  }
  const escape = () => (grid ? setGrid(false) : onExit(current))

  const keys = useRef<(key: string, shift: boolean) => boolean>(() => false)
  const onKeys = (key: string, shift: boolean): boolean => {
    wake()
    if (key === 'Escape') escape()
    else if (key === 'g' || key === 'G') toggleGrid()
    else if (grid) return false
    else if (key === 'ArrowRight') step(1)
    else if (key === 'ArrowLeft') step(-1)
    else if (key === ' ') {
      if (!scrollBy(shift ? -1 : 1)) step(shift ? -1 : 1)
    } else if (key === 'PageDown' || key === 'PageUp') scrollBy(key === 'PageUp' ? -1 : 1)
    else return false
    return true
  }
  useEffect(() => {
    keys.current = onKeys
  })
  // Called from the pages' key events only, never while rendering.
  const [fromPage] = useState(() => (key: PageKey) => void keys.current(key, false))

  // Escape goes through the keys above, so the grid closes first.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input, textarea, [role="menu"]')) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (keys.current(event.key, event.shiftKey)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const room = size
    ? {
        x: SIDE,
        y: TOP,
        width: Math.max(1, size.width - 2 * SIDE),
        height: Math.max(1, size.height - TOP - BOTTOM),
      }
    : null

  // A deck is one group without a name: its count alone.
  const where = !sheet
    ? ''
    : sheet.groupName
      ? t('present.position', { name: sheet.groupName, number: inGroup + 1, count: group.length })
      : t('present.count', { number: inGroup + 1, count: group.length })

  return (
    <Dialog open onOpenChange={(open) => !open && escape()}>
      <DialogPortal>
        <DialogPrimitive.Popup
          data-theme="dark"
          data-overlay-layer=""
          initialFocus={stage}
          onKeyDown={onKeyDown}
          onPointerMove={wake}
          className="k-present app-region-no-drag"
          data-bar={bar || undefined}
        >
          <DialogTitle className="sr-only">{t('present.label', { title })}</DialogTitle>
          <div
            ref={(el) => {
              stage.current = el
              setStageEl(el)
            }}
            tabIndex={-1}
            className="k-present__stage"
          >
            {!grid &&
              room &&
              layers.map((layer) => {
                const of = sheets.find((s) => s.key === layer.key)
                if (!of) return null
                const reading = readingFit(of, room, layer.key === current ? fit : 'auto')
                return (
                  <SheetLayer
                    key={layer.n}
                    layer={layer}
                    sheet={of}
                    reading={reading}
                    height={size!.height}
                    register={(el) => registerScroller(layer.n, el)}
                    onGone={() => setLayers((was) => was.filter((l) => l.n !== layer.n))}
                  >
                    {renderSheet(of, fromPage)}
                  </SheetLayer>
                )
              })}
            {!grid && room && sheet && (
              <>
                <Edge
                  side={-1}
                  disabled={index <= 0}
                  label={t('present.previous')}
                  width={edgeWidth(readingFit(sheet, room, fit).x)}
                  onClick={() => step(-1)}
                />
                <Edge
                  side={1}
                  disabled={index >= sheets.length - 1}
                  label={t('present.next')}
                  width={edgeWidth(readingFit(sheet, room, fit).x)}
                  onClick={() => step(1)}
                />
              </>
            )}
            {grid && (
              <PresentGrid
                sheets={sheets}
                group={gridGroup ?? sheet?.group ?? ''}
                current={current}
                onGroup={setGridGroup}
                renderThumb={renderThumb}
                onPick={(key) => {
                  go(key, 0)
                  setGrid(false)
                  requestAnimationFrame(() => stage.current?.focus({ preventScroll: true }))
                }}
              />
            )}
          </div>
          <div role="toolbar" aria-label={t('present.controls')} className="k-present__bar">
            <button
              type="button"
              className="avs-dock__btn"
              aria-label={t('present.previous')}
              title={t('present.previous')}
              disabled={index <= 0}
              onClick={() => step(-1)}
            >
              <Icon icon={ArrowLeft01Icon} size={15} />
            </button>
            <span className="k-present__where" title={sheet?.name}>
              {where}
            </span>
            <button
              type="button"
              className="avs-dock__btn"
              aria-label={t('present.next')}
              title={t('present.next')}
              disabled={index >= sheets.length - 1}
              onClick={() => step(1)}
            >
              <Icon icon={ArrowRight01Icon} size={15} />
            </button>
            <span aria-hidden className="avs-dock__rule" />
            <button
              type="button"
              className="avs-dock__btn"
              aria-label={t('present.grid')}
              title={t('present.gridKey')}
              aria-pressed={grid}
              onClick={toggleGrid}
            >
              <Icon icon={GridViewIcon} size={15} />
            </button>
            <FitMenu value={fit} onChange={setFit} />
            <span aria-hidden className="avs-dock__rule" />
            <button
              type="button"
              className="avs-dock__btn"
              data-text=""
              onClick={() => onExit(current)}
            >
              {t('present.exit')}
              <Kbd>Esc</Kbd>
            </button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

/** The side areas that step, as wide as the room beside the sheet allows. */
function edgeWidth(sheetLeft: number): number {
  return Math.max(0, Math.min(sheetLeft, 160))
}

function Edge({
  side,
  disabled,
  label,
  width,
  onClick,
}: {
  side: 1 | -1
  disabled: boolean
  label: string
  width: number
  onClick: () => void
}) {
  if (width < 24 || disabled) return null
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      className="k-present__edge"
      data-side={side > 0 ? 'right' : 'left'}
      style={{ width }}
      onClick={onClick}
    >
      <Icon icon={side > 0 ? ArrowRight01Icon : ArrowLeft01Icon} size={32} stroke={1.5} />
    </button>
  )
}

/**
 * One sheet in its own scroller, at its reading place: the room's height scrolls a long one, and
 * the wheel over its page, which does not scroll, scrolls it. It slides in from `dir`, and out.
 */
function SheetLayer({
  layer,
  sheet,
  reading,
  height,
  register,
  onGone,
  children,
}: {
  layer: Layer
  sheet: PresentSheet
  reading: Reading
  height: number
  register: (el: HTMLDivElement | null) => void
  onGone: () => void
  children: ReactNode
}) {
  const [scrolled, setScrolled] = useState(0)
  const shown = { width: sheet.width * reading.z, height: sheet.height * reading.z }
  const own = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    register(own.current)
    return () => register(null)
    // The layer's scroller is the same element for its whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      ref={own}
      className="k-present__layer"
      data-out={layer.out || undefined}
      data-in={!layer.out && layer.dir !== 0 ? '' : undefined}
      style={{ '--dir': layer.dir } as CSSProperties}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop)}
      onAnimationEnd={(event) => {
        if (layer.out && event.target === event.currentTarget) onGone()
      }}
    >
      <div
        className="k-present__room"
        style={{ height: Math.max(height, reading.y + shown.height + TOP) }}
      >
        <div
          className="k-present__sheet"
          style={{ left: reading.x, top: reading.y, width: shown.width, height: shown.height }}
        >
          <div
            className="k-present__scaled"
            style={{
              width: sheet.width,
              height: sheet.height,
              transform: `scale(${reading.z})`,
            }}
          >
            {children}
          </div>
        </div>
      </div>
      {reading.long && (
        <PositionBar
          left={Math.min(reading.x + shown.width + 10, window.innerWidth - 10)}
          top={TOP}
          track={height - TOP - BOTTOM}
          view={height}
          range={Math.max(0, reading.y + shown.height + TOP - height)}
          scrolled={scrolled}
          dark
        />
      )}
    </div>
  )
}

/** The grid: a row of the groups, and the chosen group's sheets as pictures to jump to. */
function PresentGrid({
  sheets,
  group,
  current,
  onGroup,
  renderThumb,
  onPick,
}: {
  sheets: readonly PresentSheet[]
  group: string
  current: string
  onGroup: (group: string) => void
  renderThumb: (sheet: PresentSheet) => ReactNode
  onPick: (key: string) => void
}) {
  const groups: { key: string; name: string }[] = []
  for (const s of sheets) {
    if (!groups.some((g) => g.key === s.group)) groups.push({ key: s.group, name: s.groupName })
  }
  const shown = sheets.filter((s) => s.group === group)
  const focused = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    focused.current?.focus({ preventScroll: true })
    focused.current?.scrollIntoView({ block: 'nearest' })
  }, [group])
  return (
    <div className="k-present__grid">
      {groups.length > 1 && (
        <div role="tablist" className="k-present__tabs">
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              role="tab"
              aria-selected={g.key === group}
              className="k-present__tab"
              onClick={() => onGroup(g.key)}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}
      <div className="k-present__wall" key={group}>
        {shown.map((s, i) => (
          <button
            key={s.key}
            ref={
              s.key === current || (i === 0 && !shown.some((x) => x.key === current))
                ? focused
                : undefined
            }
            type="button"
            className="k-present__item"
            data-on={s.key === current || undefined}
            style={{ '--i': Math.min(i, 16) } as CSSProperties}
            onClick={() => onPick(s.key)}
          >
            <span
              className={cn('k-present__thumb')}
              style={{ width: Math.min(360, (160 / s.height) * s.width) }}
            >
              {renderThumb(s)}
            </span>
            <span className="k-present__name">{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
