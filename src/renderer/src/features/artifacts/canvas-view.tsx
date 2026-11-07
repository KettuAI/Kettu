import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CenterFocusIcon, Download04Icon, PlayIcon } from '@hugeicons/core-free-icons'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_FRAME_SANDBOX, WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { glide } from '@renderer/lib/motion'
import { isWeb } from '@renderer/lib/platform'
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
import { useEditorFrame, useEditorState, type ArtifactEditor, type EditorFrame } from './editor'
import { isModeKey } from './keys'
import { pageUrl } from './use-artifact'
import { BarButton } from './viewer-parts'

/** Pages that may start loading in one frame. */
const LOADS_PER_FRAME = 2
/** The layer keeps `will-change` this long after the camera stops, then draws crisp again. */
const SETTLE_MS = 160
/** A press that moves less than this is a click. */
const DRAG_SLOP = 3
const LABEL_HEIGHT = 20
/** The spacing of the ground's dots, in screen pixels. */
const DOT_STEP = 20

const mod = (value: number, step: number): number => (((value % step) + step) % step) - step
const TITLE_ABOVE = 40
/** A page's actions: three 24 px buttons, over the right of its name. */
const ACTIONS_WIDTH = 80
const ACTIONS_HEIGHT = 26

/** What a page's actions do, in the viewer; the pane shows none. */
export interface PageActions {
  download: ((index: number) => void) | null
  present: (index: number) => void
}

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
  bottom = 0,
  onEscape,
  editor,
  actions,
  onPageChosen,
}: {
  url: string
  version: number
  title: string
  layout: CanvasLayout
  reloads: number
  controls: CanvasControls
  /** Screen pixels at the top that a bar covers, kept clear when fitting. */
  top?: number
  /** Screen pixels at the bottom that a toolbar covers, kept clear when fitting. */
  bottom?: number
  /** Esc on the canvas itself, after a focused page has been left. */
  onEscape?: () => void
  /** Select and comment mode, where the canvas can show them. */
  editor?: ArtifactEditor
  actions?: PageActions
  /** The page the user chose, by click or key, as its place in `layout.pages`. */
  onPageChosen?: (index: number) => void
}) {
  const { t } = useTranslation('artifacts')
  const stage = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const dots = useRef<HTMLDivElement>(null)
  const labels = useRef<(HTMLSpanElement | null)[]>([])
  const actionBars = useRef<(HTMLDivElement | null)[]>([])
  const frames = useRef(new Map<number, HTMLIFrameElement>())
  const editorFrames = useRef(new Map<number, EditorFrame>())
  const pointed = useRef(-1)
  const editing = useEditorState(editor)
  const mode = editor ? editing.mode : null
  const camera = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const view = useRef<Size>({ width: 0, height: 0 })
  const fitted = useRef(false)
  // Whether the camera is where Zoom to fit put it; a resize or a new layout fits again then.
  const atFit = useRef(false)
  const glideTo = useRef<AnimationPlaybackControls | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const liveFrame = useRef(0)
  const [live, setLive] = useState<ReadonlySet<number>>(new Set())
  const [picked, setSelected] = useState(0)
  // The selection shows once a page is picked, or while the canvas has the keyboard's focus.
  const [chosen, setChosen] = useState(false)
  const [keyFocus, setKeyFocus] = useState(false)
  const [hovered, setHovered] = useState(-1)
  const [dragging, setDragging] = useState(false)
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
    // The ground's dots keep their spacing and follow the pan, a step of them at most.
    if (dots.current) {
      dots.current.style.transform = `translate(${mod(x, DOT_STEP)}px, ${mod(y, DOT_STEP)}px)`
    }
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
      const bar = actionBars.current[i]
      const shown = p.width * z >= NAME_MIN_WIDTH && (p.y === 0 || room.names)
      // The actions sit at the right end of the name's row, when it has room for both.
      const withActions = Boolean(actions) && shown && p.width * z >= ACTIONS_WIDTH + NAME_MIN_WIDTH
      if (bar) {
        bar.style.visibility = withActions ? '' : 'hidden'
        if (withActions) {
          bar.style.transform =
            `translate(${(p.x + p.width) * z + x - ACTIONS_WIDTH}px, ` +
            `${p.y * z + y - LABEL_HEIGHT - (ACTIONS_HEIGHT - LABEL_HEIGHT) / 2 - 3}px)`
        }
      }
      if (!label) return
      label.style.visibility = shown ? '' : 'hidden'
      if (!shown) return
      label.style.transform = `translate(${p.x * z + x}px, ${p.y * z + y - LABEL_HEIGHT}px)`
      label.style.maxWidth = `${p.width * z - (withActions ? ACTIONS_WIDTH : 0)}px`
    })
    controls.publish({ zoom: z, fitted: atFit.current })
    syncLive()
  }, [pages, titles, controls, syncLive, actions])

  const place = useCallback(
    (next: Camera, fit = false) => {
      glideTo.current?.stop()
      atFit.current = fit
      camera.current = next
      draw()
    },
    [draw],
  )

  /** Moves the camera for a button or key: a glide, or a jump under reduce motion. */
  const moveTo = useCallback(
    (target: Camera, fit = false) => {
      glideTo.current?.stop()
      if (prefersReducedMotion()) return place(target, fit)
      atFit.current = fit
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
        bottom,
      )
      if (glides) moveTo(target, true)
      else place(target, true)
    },
    [layout.width, layout.height, top, bottom, moveTo, place],
  )

  const fitPage = useCallback(
    (index: number) => {
      const p = pages[index]
      if (p) {
        moveTo(
          fitBox({ x: p.x, y: p.y, width: p.width, height: p.height }, view.current, top, bottom),
        )
      }
    },
    [pages, top, bottom, moveTo],
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
      setChosen(true)
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
    [pages, moveTo, setSelected, setChosen],
  )

  // The view's size; the first one fits every page, and a fitted canvas fits again as it changes.
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      // Observing again reports the same size, which leaves a glide under way alone.
      if (width === view.current.width && height === view.current.height) return
      view.current = { width, height }
      if (!fitted.current && width > 0) {
        fitted.current = true
        fitAll(false)
      } else if (atFit.current) {
        fitAll(false)
      } else {
        draw()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fitAll, draw])

  // A new version may hold other pages: the camera stays, or fits them all if it was fitted; the
  // selection stays on the canvas.
  const lastLayout = useRef(layout)
  useEffect(() => {
    if (lastLayout.current === layout) return
    lastLayout.current = layout
    if (!fitted.current) return
    if (atFit.current) fitAll(false)
    else draw()
  }, [layout, fitAll, draw])

  // A bar that comes or goes moves the canvas with it, so it never covers what was in view.
  const lastTop = useRef(top)
  useEffect(() => {
    const by = top - lastTop.current
    lastTop.current = top
    if (by === 0 || !fitted.current) return
    if (atFit.current) fitAll(true)
    else moveTo({ ...camera.current, y: camera.current.y + by })
  }, [top, moveTo, fitAll])

  useEffect(() => {
    controls.publish({ selected, focused, count: pages.length })
  }, [controls, selected, focused, pages.length])

  useEffect(() => {
    if (chosen) onPageChosen?.(selected)
  }, [chosen, selected, onPageChosen])

  const selectedNow = useRef(selected)
  useEffect(() => {
    selectedNow.current = selected
  }, [selected])
  useEffect(
    () =>
      controls.attach({
        zoomStep: (direction) => zoomAround(stepZoom(camera.current.z, direction)),
        fitAll: () => fitAll(true),
        fitSelected: () => fitPage(selectedNow.current),
        actualSize: () => zoomAround(1),
        focus: (index) => {
          if (index !== null) {
            setSelected(index)
            setChosen(true)
          }
          setFocused(index)
        },
      }),
    [controls, zoomAround, fitAll, fitPage],
  )

  // Reload loads every live page again, in place.
  const [mountedAt] = useState(reloads)
  useEffect(() => {
    if (reloads === mountedAt) return
    // Setting the attribute again navigates the frame, even to the same address.
    for (const frame of frames.current.values()) frame.setAttribute('src', frame.src)
  }, [reloads, mountedAt])

  // Effects may run again on the same canvas, as React's development checks do, which must not
  // leave the live pages it was loading unloaded.
  useEffect(() => {
    syncLive()
    return () => {
      glideTo.current?.stop()
      cancelAnimationFrame(liveFrame.current)
      clearTimeout(settle.current)
    }
  }, [syncLive])

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

  /** A spot on the screen in the pixels of page `index`. */
  const toPage = (index: number, sx: number, sy: number) => {
    const p = pages[index]!
    const { x, y, z } = camera.current
    return { x: (sx - (p.x * z + x)) / z, y: (sy - (p.y * z + y)) / z }
  }

  /** Outlines what is under the pointer in its page, and nothing in the page it left. */
  const pointAt = (index: number, sx: number, sy: number) => {
    if (pointed.current !== index) editorFrames.current.get(pointed.current)?.leave()
    pointed.current = index
    const frame = editorFrames.current.get(index)
    if (!frame) return
    const local = toPage(index, sx, sy)
    frame.point(local.x, local.y)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) {
      return
    }
    const key = event.key
    const count = pages.length
    const modeKey = editor ? isModeKey(event.nativeEvent) : null
    if (modeKey) editor!.toggle(modeKey)
    else if (key === 'Escape' && editor?.escape()) {
      // Back to the base mode, or the pick let go of, before Esc means anything else.
    } else if (event.shiftKey && event.code === 'Digit1') fitAll(true)
    else if (event.shiftKey && event.code === 'Digit2') fitPage(selected)
    else if (event.shiftKey && event.code === 'Digit0') zoomAround(1)
    else if (key === 'ArrowRight') select(Math.min(count - 1, selected + 1), true)
    else if (key === 'ArrowLeft') select(Math.max(0, selected - 1), true)
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      const next = pageInNextRow(pages, selected, key === 'ArrowUp' ? -1 : 1)
      if (next < 0) return
      select(next, true)
    } else if (key === 'Enter') {
      setChosen(true)
      setFocused(selected)
    } else if (key === '+' || key === '=') zoomAround(stepZoom(camera.current.z, 1))
    else if (key === '-') zoomAround(stepZoom(camera.current.z, -1))
    else if (key === 'Escape' && onEscape) onEscape()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const shownPage = focused === null ? null : (pages[focused] ?? null)
  const ringed = chosen || keyFocus ? selected : -1

  return (
    <div className="absolute inset-0 overflow-hidden bg-sidebar">
      <div
        ref={dots}
        aria-hidden
        className="absolute -inset-5 bg-[radial-gradient(var(--border-default)_1px,transparent_1px)] bg-size-[20px_20px]"
      />
      <div
        ref={stage}
        tabIndex={0}
        role="region"
        aria-roledescription={t('canvas.role')}
        aria-label={title}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target === event.currentTarget) {
            setKeyFocus(event.currentTarget.matches(':focus-visible'))
          }
        }}
        onBlur={(event) => {
          if (event.target === event.currentTarget) setKeyFocus(false)
        }}
        className="absolute inset-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
      >
        {/* In the overview the pages take no pointer and no focus, but their scripts keep running. */}
        <div ref={layer} inert className="absolute top-0 left-0 origin-top-left">
          {pages.map((p, i) => (
            <div
              key={`${p.group}.${p.index}`}
              className={cn(
                // Each page lies on the desk; its edge keeps a screen hairline at any zoom.
                'absolute overflow-hidden rounded-[calc(6px*var(--unscale))] bg-canvas',
                i === ringed
                  ? // A gap of the desk first, so the ring shows beside a page of any color.
                    'shadow-[0_0_0_calc(2px*var(--unscale))_var(--bg-sidebar),0_0_0_calc(4px*var(--unscale))_var(--text-primary),var(--elevation-page-drop)]'
                  : i === hovered
                    ? 'shadow-[0_0_0_calc(var(--hairline)*var(--unscale))_var(--border-strong),var(--elevation-page-drop)]'
                    : 'shadow-[0_0_0_calc(var(--hairline)*var(--unscale))_var(--border-default),var(--elevation-page-drop)]',
              )}
              style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
            >
              {live.has(i) ? (
                <CanvasFrame
                  src={pageUrl(url, version, p)}
                  title={name(p)}
                  width={p.width}
                  height={p.height}
                  editor={editor}
                  page={i}
                  register={(frame) => {
                    if (frame) frames.current.set(i, frame)
                    else frames.current.delete(i)
                  }}
                  registerEditor={(frame) => {
                    if (frame) editorFrames.current.set(i, frame)
                    else editorFrames.current.delete(i)
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
          className={cn(
            'absolute inset-0',
            dragging
              ? 'cursor-grabbing'
              : mode === 'comment'
                ? 'cursor-crosshair'
                : mode === 'select'
                  ? 'cursor-default'
                  : 'cursor-grab',
          )}
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
              const index = pageAt(pages, camera.current, sx, sy)
              setHovered(index)
              if (mode) pointAt(index, sx, sy)
              return
            }
            const dx = event.clientX - held.x
            const dy = event.clientY - held.y
            if (!held.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
              held.moved = true
              setDragging(true)
            }
            if (held.moved) place({ ...held.camera, x: held.camera.x + dx, y: held.camera.y + dy })
          }}
          onPointerUp={(event) => {
            const held = press.current
            press.current = null
            setDragging(false)
            if (!held || held.moved) return
            const { sx, sy } = point(event)
            const index = pageAt(pages, camera.current, sx, sy)
            if (index >= 0) {
              setSelected(index)
              setChosen(true)
            }
            if (mode && editor) {
              const frame = editorFrames.current.get(index)
              if (frame) {
                const local = toPage(index, sx, sy)
                frame.pick(local.x, local.y, { x: event.clientX, y: event.clientY })
              } else editor.clearPick()
            }
            stage.current?.focus({ preventScroll: true })
          }}
          onPointerCancel={() => {
            press.current = null
            setDragging(false)
          }}
          onPointerLeave={() => {
            setHovered(-1)
            if (mode) pointAt(-1, 0, 0)
          }}
          onDoubleClick={(event) => {
            if (mode === 'comment') return
            const { sx, sy } = point(event)
            const index = pageAt(pages, camera.current, sx, sy)
            if (index < 0) return
            setSelected(index)
            setChosen(true)
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
              className="absolute top-0 left-0 truncate text-xs whitespace-nowrap text-tertiary"
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
        {actions && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {pages.map((p, i) => (
              <div
                key={`${p.group}.${p.index}`}
                ref={(el) => {
                  actionBars.current[i] = el
                }}
                style={{ width: ACTIONS_WIDTH, height: ACTIONS_HEIGHT }}
                className="pointer-events-auto absolute top-0 left-0 flex items-center justify-end gap-0.5"
              >
                {actions.download && (
                  <BarButton
                    label={t('canvas.downloadPng')}
                    size="pane"
                    icon={Download04Icon}
                    onClick={() => actions.download?.(i)}
                  />
                )}
                <BarButton
                  label={t('canvas.presentFrom')}
                  size="pane"
                  icon={PlayIcon}
                  onClick={() => actions.present(i)}
                />
                <BarButton
                  label={t('canvas.focusPage')}
                  shortcut="↵"
                  size="pane"
                  icon={CenterFocusIcon}
                  onClick={() => {
                    setSelected(i)
                    setChosen(true)
                    setFocused(i)
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {shownPage && (
        <FocusedPage
          key={`${shownPage.group}.${shownPage.index}`}
          src={pageUrl(url, version, shownPage)}
          page={shownPage}
          name={name(shownPage)}
          top={top}
          reloads={reloads}
          editor={editor}
          index={focused!}
          onMove={(step) => {
            const next = focused! + step
            if (next < 0 || next >= pages.length) return
            setSelected(next)
            setChosen(true)
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
export function CanvasFrame({
  src,
  title,
  width,
  height,
  editor,
  page,
  register,
  registerEditor,
}: {
  src: string
  title: string
  width: number
  height: number
  editor: ArtifactEditor | undefined
  page: number
  register: (frame: HTMLIFrameElement | null) => void
  registerEditor: (frame: EditorFrame | null) => void
}) {
  const [loaded, setLoaded] = useState(false)
  const driven = useEditorFrame(editor, page)
  const { frame, ref: drivenRef } = driven
  useEffect(() => {
    registerEditor(frame)
    return () => registerEditor(null)
  }, [frame, registerEditor])
  return (
    <iframe
      ref={(el) => {
        register(el)
        drivenRef(el)
      }}
      src={src}
      title={title}
      tabIndex={-1}
      sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
      allow=""
      referrerPolicy="no-referrer"
      onLoad={() => {
        setLoaded(true)
        driven.onLoad()
      }}
      style={{ width, height }}
      className={cn(
        'block border-0 opacity-0 transition-opacity duration-(--duration-fast)',
        loaded && 'opacity-100',
      )}
    />
  )
}

/** A focused page alone in the area, live and interactive, fitted and never above 100%. */
export function FocusedPage({
  src,
  page,
  name,
  top,
  reloads,
  editor,
  index,
  onMove,
  onLeave,
}: {
  src: string
  page: PlacedPage
  name: string
  top: number
  reloads: number
  editor: ArtifactEditor | undefined
  index: number
  onMove: (step: 1 | -1) => void
  onLeave: () => void
}) {
  const area = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [mountedAt] = useState(reloads)
  const driven = useEditorFrame(editor, index)
  const mode = useEditorState(editor).mode

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
        const modeKey = editor ? isModeKey(event.nativeEvent) : null
        if (modeKey) editor!.toggle(modeKey)
        else if (event.key === 'Escape' && editor?.escape()) {
          // Back to the base mode, or the pick let go of, before leaving the page.
        } else if (event.key === 'Escape') onLeave()
        else if (event.key === 'ArrowRight') onMove(1)
        else if (event.key === 'ArrowLeft') onMove(-1)
        else return
        event.preventDefault()
        event.stopPropagation()
      }}
      style={{ paddingTop: top }}
      className="absolute inset-0 flex items-center justify-center bg-sidebar outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
    >
      {size && (
        <div
          className="relative shrink-0 overflow-hidden bg-canvas shadow-(--elevation-page)"
          style={{ width: page.width * scale, height: page.height * scale }}
        >
          <iframe
            ref={(el) => {
              frame.current = el
              driven.ref(el)
            }}
            src={src}
            title={name}
            sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
            allow=""
            referrerPolicy="no-referrer"
            onLoad={() => {
              setLoaded(true)
              driven.onLoad()
            }}
            style={{ width: page.width, height: page.height, transform: `scale(${scale})` }}
            className={cn(
              'block origin-top-left border-0 opacity-0 transition-opacity duration-(--duration-fast)',
              loaded && 'opacity-100',
            )}
          />
          {mode && driven.frame && (
            <PickLayer
              frame={driven.frame}
              scale={scale}
              mode={mode}
              onDone={() => area.current?.focus({ preventScroll: true })}
            />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Over a page that takes the pointer, in select or comment mode: the pointer outlines and picks
 * elements through the page's runtime instead of using the page. `scale` is the page's on screen.
 */
export function PickLayer({
  frame,
  scale,
  mode,
  onDone,
}: {
  frame: EditorFrame
  scale: number
  mode: 'select' | 'comment'
  onDone?: () => void
}) {
  const local = (event: React.PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }
  }
  return (
    <div
      aria-hidden
      className={cn('absolute inset-0', mode === 'comment' ? 'cursor-crosshair' : 'cursor-default')}
      onPointerMove={(event) => {
        const at = local(event)
        frame.point(at.x, at.y)
      }}
      onPointerLeave={() => frame.leave()}
      onClick={(event) => {
        const at = local(event as unknown as React.PointerEvent)
        frame.pick(at.x, at.y, { x: event.clientX, y: event.clientY })
        onDone?.()
      }}
    />
  )
}
