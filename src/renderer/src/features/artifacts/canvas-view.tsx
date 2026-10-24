import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { glide } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  between,
  fitBox,
  labelRoom,
  livePages,
  NAME_MIN_WIDTH,
  pageAt,
  pageInNextRow,
  reveal,
  stepZoom,
  TITLE_MIN_WIDTH,
  zoomAt,
  type Camera,
  type Size,
} from './camera'
import type { CanvasLayout, PlacedPage } from './canvas'
import type { CanvasControls } from './canvas-controls'
import { pageUrl } from './use-artifact'

/** Pages that may start loading in one frame. */
const LOADS_PER_FRAME = 2
/** The layer keeps `will-change` this long after the camera stops, then draws crisp again. */
const SETTLE_MS = 160
/** A press that moves less than this is a click. */
const DRAG_SLOP = 3
const LABEL_HEIGHT = 20
const TITLE_ABOVE = 42

/**
 * An artifact's pages side by side on a surface that pans and zooms: one transform on the layer,
 * written straight to it each frame; the pages near the view stay live; one page at a time can be
 * focused, alone and interactive.
 */
export const CanvasView = memo(function CanvasView({
  url,
  version,
  title,
  layout,
  reloads,
  controls,
  top = 0,
  onEscape,
}: {
  url: string
  version: number
  title: string
  layout: CanvasLayout
  reloads: number
  controls: CanvasControls
  /** Screen pixels at the top that a bar covers, kept clear when fitting. */
  top?: number
  /** Esc on the canvas itself, after a focused page has been left. */
  onEscape?: () => void
}) {
  const { t } = useTranslation('artifacts')
  const stage = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const labels = useRef<(HTMLSpanElement | null)[]>([])
  const frames = useRef(new Map<number, HTMLIFrameElement>())
  const camera = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const view = useRef<Size>({ width: 0, height: 0 })
  const fitted = useRef(false)
  const glideTo = useRef<AnimationPlaybackControls | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const liveFrame = useRef(0)
  const [live, setLive] = useState<ReadonlySet<number>>(new Set())
  const [picked, setSelected] = useState(0)
  const [hovered, setHovered] = useState(-1)
  const [focusedAt, setFocused] = useState<number | null>(null)
  const { pages, titles } = layout
  const selected = Math.min(picked, pages.length - 1)
  const focused = focusedAt === null ? null : Math.min(focusedAt, pages.length - 1)
  const name = useCallback((p: PlacedPage) => p.name ?? t('canvas.page', { number: p.number }), [t])

  // Live pages follow the camera, nearest first, a few more each frame.
  const syncLive = useCallback(() => {
    const step = (): void => {
      const wanted = livePages(pages, camera.current, view.current)
      setLive((current) => {
        const next = new Set(wanted.filter((i) => current.has(i)))
        let added = 0
        for (const i of wanted) {
          if (next.has(i)) continue
          if (added === LOADS_PER_FRAME) break
          next.add(i)
          added++
        }
        if (next.size < wanted.length) liveFrame.current = requestAnimationFrame(step)
        const same = next.size === current.size && [...next].every((i) => current.has(i))
        return same ? current : next
      })
    }
    cancelAnimationFrame(liveFrame.current)
    liveFrame.current = requestAnimationFrame(step)
  }, [pages])

  const draw = useCallback(() => {
    const { x, y, z } = camera.current
    const el = layer.current
    if (el) {
      el.style.transform = `translate(${x}px, ${y}px) scale(${z})`
      el.style.setProperty('--unscale', String(1 / z))
      el.style.willChange = 'transform'
    }
    clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      if (layer.current) layer.current.style.willChange = ''
    }, SETTLE_MS)
    const room = labelRoom(z)
    titles.forEach((row, i) => {
      const label = labels.current[pages.length + i]
      if (!label) return
      const first = row.y === 0
      const shown = row.width * z >= TITLE_MIN_WIDTH && (first || room.title)
      label.style.visibility = shown ? '' : 'hidden'
      if (!shown) return
      const lift = first || room.names ? TITLE_ABOVE : LABEL_HEIGHT
      label.style.transform = `translate(${row.x * z + x}px, ${row.y * z + y - lift}px)`
      label.style.maxWidth = `${row.width * z}px`
    })
    pages.forEach((p, i) => {
      const label = labels.current[i]
      if (!label) return
      const shown = p.width * z >= NAME_MIN_WIDTH && (p.y === 0 || room.names)
      label.style.visibility = shown ? '' : 'hidden'
      if (!shown) return
      label.style.transform = `translate(${p.x * z + x}px, ${p.y * z + y - LABEL_HEIGHT}px)`
      label.style.maxWidth = `${p.width * z}px`
    })
    controls.publish({ zoom: z })
    syncLive()
  }, [pages, titles, controls, syncLive])

  const place = useCallback(
    (next: Camera) => {
      glideTo.current?.stop()
      camera.current = next
      draw()
    },
    [draw],
  )

  /** Moves the camera for a button or key: a glide, or a jump under reduce motion. */
  const moveTo = useCallback(
    (target: Camera) => {
      glideTo.current?.stop()
      if (prefersReducedMotion()) return place(target)
      const from = camera.current
      glideTo.current = animate(0, 1, {
        ...glide,
        onUpdate: (t) => {
          camera.current = between(from, target, t, view.current)
          draw()
        },
      })
    },
    [place, draw],
  )

  const fitAll = useCallback(
    (glides: boolean) => {
      const target = fitBox(
        { x: 0, y: 0, width: layout.width, height: layout.height },
        view.current,
        top,
      )
      if (glides) moveTo(target)
      else place(target)
    },
    [layout.width, layout.height, top, moveTo, place],
  )

  const fitPage = useCallback(
    (index: number) => {
      const p = pages[index]
      if (p) moveTo(fitBox({ x: p.x, y: p.y, width: p.width, height: p.height }, view.current, top))
    },
    [pages, top, moveTo],
  )

  const zoomAround = useCallback(
    (z: number) => {
      const { width, height } = view.current
      moveTo(zoomAt(camera.current, z, width / 2, height / 2))
    },
    [moveTo],
  )

  const select = useCallback(
    (index: number, show: boolean) => {
      const p = pages[index]
      if (!p) return
      setSelected(index)
      if (show) {
        const box = {
          x: p.x,
          y: p.y - LABEL_HEIGHT / camera.current.z,
          width: p.width,
          height: p.height,
        }
        const target = reveal(camera.current, box, view.current)
        if (target.x !== camera.current.x || target.y !== camera.current.y) moveTo(target)
      }
    },
    [pages, moveTo],
  )

  // The view's size; the first one fits every page.
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      view.current = { width: entry.contentRect.width, height: entry.contentRect.height }
      if (!fitted.current && view.current.width > 0) {
        fitted.current = true
        fitAll(false)
      } else {
        draw()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fitAll, draw])

  // A new version may hold other pages: the camera stays, the selection stays on the canvas.
  useEffect(() => {
    if (fitted.current) draw()
  }, [pages, draw])

  useEffect(() => {
    controls.publish({ selected, focused, count: pages.length })
  }, [controls, selected, focused, pages.length])

  useEffect(
    () =>
      controls.attach({
        zoomStep: (direction) => zoomAround(stepZoom(camera.current.z, direction)),
        fitAll: () => fitAll(true),
        focus: (index) => {
          if (index !== null) setSelected(index)
          setFocused(index)
        },
      }),
    [controls, zoomAround, fitAll],
  )

  // Reload loads every live page again, in place.
  const [mountedAt] = useState(reloads)
  useEffect(() => {
    if (reloads === mountedAt) return
    // Setting the attribute again navigates the frame, even to the same address.
    for (const frame of frames.current.values()) frame.setAttribute('src', frame.src)
  }, [reloads, mountedAt])

  useEffect(
    () => () => {
      glideTo.current?.stop()
      cancelAnimationFrame(liveFrame.current)
      clearTimeout(settle.current)
    },
    [],
  )

  // The wheel pans, and zooms with Mod or a pinch, which Chromium sends as Ctrl and the wheel.
  useEffect(() => {
    const el = stage.current
    if (!el || focused !== null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.current.height : 1
      const current = camera.current
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect()
        const delta = Math.max(-50, Math.min(50, event.deltaY * unit))
        place(
          zoomAt(
            current,
            current.z * Math.exp(-delta * 0.01),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        )
      } else {
        place({
          ...current,
          x: current.x - event.deltaX * unit,
          y: current.y - event.deltaY * unit,
        })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [focused, place])

  const press = useRef<{ x: number; y: number; camera: Camera; moved: boolean } | null>(null)
  const point = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = stage.current!.getBoundingClientRect()
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) {
      return
    }
    const key = event.key
    const count = pages.length
    if (event.shiftKey && event.code === 'Digit1') fitAll(true)
    else if (event.shiftKey && event.code === 'Digit2') fitPage(selected)
    else if (event.shiftKey && event.code === 'Digit0') zoomAround(1)
    else if (key === 'ArrowRight') select(Math.min(count - 1, selected + 1), true)
    else if (key === 'ArrowLeft') select(Math.max(0, selected - 1), true)
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      const next = pageInNextRow(pages, selected, key === 'ArrowUp' ? -1 : 1)
      if (next < 0) return
      select(next, true)
    } else if (key === 'Enter') setFocused(selected)
    else if (key === '+' || key === '=') zoomAround(stepZoom(camera.current.z, 1))
    else if (key === '-') zoomAround(stepZoom(camera.current.z, -1))
    else if (key === 'Escape' && onEscape) onEscape()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const shownPage = focused === null ? null : (pages[focused] ?? null)

  return (
    <div className="absolute inset-0 overflow-hidden bg-sidebar">
      <div
        ref={stage}
        tabIndex={0}
        role="region"
        aria-roledescription={t('canvas.role')}
        aria-label={title}
        onKeyDown={onKeyDown}
        className="absolute inset-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
      >
        {/* In the overview the pages take no pointer and no focus, but their scripts keep running. */}
        <div ref={layer} inert className="absolute top-0 left-0 origin-top-left">
          {pages.map((p, i) => (
            <div
              key={`${p.group}.${p.index}`}
              className={cn(
                'absolute overflow-hidden bg-canvas',
                i === selected
                  ? 'shadow-[0_0_0_calc(2px*var(--unscale))_var(--text-primary)]'
                  : i === hovered
                    ? 'shadow-[0_0_0_calc(var(--hairline)*var(--unscale))_var(--border-strong)]'
                    : 'shadow-[0_0_0_calc(var(--hairline)*var(--unscale))_var(--border-default)]',
              )}
              style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
            >
              {live.has(i) ? (
                <CanvasFrame
                  src={pageUrl(url, version, p)}
                  title={name(p)}
                  width={p.width}
                  height={p.height}
                  register={(frame) => {
                    if (frame) frames.current.set(i, frame)
                    else frames.current.delete(i)
                  }}
                />
              ) : (
                <div className="flex size-full items-center justify-center bg-subtle text-tertiary">
                  <span className="truncate px-[calc(12px*var(--unscale))] text-[calc(12px*var(--unscale))]">
                    {name(p)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div
          aria-hidden
          className="absolute inset-0"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            press.current = {
              x: event.clientX,
              y: event.clientY,
              camera: camera.current,
              moved: false,
            }
          }}
          onPointerMove={(event) => {
            const held = press.current
            if (!held) {
              const { sx, sy } = point(event)
              setHovered(pageAt(pages, camera.current, sx, sy))
              return
            }
            const dx = event.clientX - held.x
            const dy = event.clientY - held.y
            if (!held.moved && Math.hypot(dx, dy) > DRAG_SLOP) held.moved = true
            if (held.moved) place({ ...held.camera, x: held.camera.x + dx, y: held.camera.y + dy })
          }}
          onPointerUp={(event) => {
            const held = press.current
            press.current = null
            if (!held || held.moved) return
            const { sx, sy } = point(event)
            const index = pageAt(pages, camera.current, sx, sy)
            if (index >= 0) setSelected(index)
            stage.current?.focus({ preventScroll: true })
          }}
          onPointerLeave={() => setHovered(-1)}
          onDoubleClick={(event) => {
            const { sx, sy } = point(event)
            const index = pageAt(pages, camera.current, sx, sy)
            if (index < 0) return
            setSelected(index)
            setFocused(index)
          }}
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          {pages.map((p, i) => (
            <span
              key={`${p.group}.${p.index}`}
              ref={(el) => {
                labels.current[i] = el
              }}
              className={cn(
                'absolute top-0 left-0 truncate text-xs whitespace-nowrap',
                i === selected ? 'text-primary' : 'text-tertiary',
              )}
            >
              {name(p)}
            </span>
          ))}
          {titles.map((row, i) => (
            <span
              key={`title-${row.y}`}
              ref={(el) => {
                labels.current[pages.length + i] = el
              }}
              className="absolute top-0 left-0 truncate text-xs font-medium whitespace-nowrap text-primary"
            >
              {row.title}
            </span>
          ))}
        </div>
      </div>
      {shownPage && (
        <FocusedPage
          key={`${shownPage.group}.${shownPage.index}`}
          src={pageUrl(url, version, shownPage)}
          page={shownPage}
          name={name(shownPage)}
          top={top}
          reloads={reloads}
          onMove={(step) => {
            const next = focused! + step
            if (next < 0 || next >= pages.length) return
            setSelected(next)
            setFocused(next)
          }}
          onLeave={() => {
            setFocused(null)
            requestAnimationFrame(() => stage.current?.focus({ preventScroll: true }))
          }}
        />
      )}
    </div>
  )
})

/** One page on the canvas, at its own size, shown once it has loaded. */
function CanvasFrame({
  src,
  title,
  width,
  height,
  register,
}: {
  src: string
  title: string
  width: number
  height: number
  register: (frame: HTMLIFrameElement | null) => void
}) {
  const [loaded, setLoaded] = useState(false)
  return (
    <iframe
      ref={register}
      src={src}
      title={title}
      tabIndex={-1}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      style={{ width, height }}
      className={cn(
        'block border-0 opacity-0 transition-opacity duration-(--duration-fast)',
        loaded && 'opacity-100',
      )}
    />
  )
}

/** A focused page alone in the area, live and interactive, fitted and never above 100%. */
function FocusedPage({
  src,
  page,
  name,
  top,
  reloads,
  onMove,
  onLeave,
}: {
  src: string
  page: PlacedPage
  name: string
  top: number
  reloads: number
  onMove: (step: 1 | -1) => void
  onLeave: () => void
}) {
  const area = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [mountedAt] = useState(reloads)

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    el.focus({ preventScroll: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (reloads !== mountedAt && frame.current) frame.current.src = src
  }, [reloads, mountedAt, src])

  const scale = size
    ? Math.min(1, (size.width - 48) / page.width, (size.height - top - 48) / page.height)
    : 0

  return (
    <div
      ref={area}
      tabIndex={0}
      aria-label={name}
      onKeyDown={(event) => {
        // Keys typed in the page stay there.
        if (event.target !== event.currentTarget) return
        if (event.key === 'Escape') onLeave()
        else if (event.key === 'ArrowRight') onMove(1)
        else if (event.key === 'ArrowLeft') onMove(-1)
        else return
        event.preventDefault()
        event.stopPropagation()
      }}
      style={{ paddingTop: top }}
      className="absolute inset-0 flex items-center justify-center bg-sidebar outline-none"
    >
      {size && (
        <div
          className="relative shrink-0 overflow-hidden bg-canvas shadow-[0_0_0_var(--hairline)_var(--border-default)]"
          style={{ width: page.width * scale, height: page.height * scale }}
        >
          <iframe
            ref={frame}
            src={src}
            title={name}
            sandbox={ARTIFACT_FRAME_SANDBOX}
            allow=""
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
            className={cn(
              'block origin-top-left border-0 opacity-0 transition-opacity duration-(--duration-fast)',
              loaded && 'opacity-100',
            )}
          />
        </div>
      )}
    </div>
  )
}
