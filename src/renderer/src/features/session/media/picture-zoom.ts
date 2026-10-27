// What a picture does on its stage, in the viewer and in the Files pane: its zoom and its pan.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { isEditable } from '@renderer/features/artifacts/keys'
import { follow } from '@renderer/lib/motion'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  bounded,
  fitZoom,
  isZoomed,
  PIXELATED_FROM,
  snapped,
  stepZoom,
  toggled,
  zoomAt,
  type Camera,
  type Size,
} from './zoom'

/** What a picture's buttons and keys do to it. */
export interface PictureControls {
  zoomBy(direction: 1 | -1): void
  fit(): void
  actual(): void
  toggle(): void
}

/**
 * Fit on Shift+1, actual size on Shift+0, and a step either way on + or = and -, never with Alt,
 * Ctrl or Cmd held and never in a text field. Whether it handled the key.
 */
export function handleZoomKeys(
  event: KeyboardEvent<Element>,
  controls: PictureControls | null,
): boolean {
  if (
    !controls ||
    event.defaultPrevented ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    isEditable(event.target)
  ) {
    return false
  }
  const { key, code, shiftKey } = event
  if (shiftKey && code === 'Digit1') controls.fit()
  else if (shiftKey && code === 'Digit0') controls.actual()
  else if (key === '+' || key === '=') controls.zoomBy(1)
  else if (key === '-') controls.zoomBy(-1)
  else return false
  event.preventDefault()
  return true
}

/** The size an image without one of its own, such as an SVG with only a viewBox, takes. */
export const DEFAULT_PICTURE_SIZE: Size = { width: 300, height: 150 }

/** A press that moves less than this is a click. */
const DRAG_SLOP = 4
/** The picture keeps `will-change` this long after the camera stops, then draws crisp again. */
const SETTLE_MS = 160
/** A wheel or pinch zoom has ended once no event came for this long. */
const GESTURE_END_MS = 150

export interface PictureZoomOptions {
  /** The picture's own pixels; null while it is no picture, or has not loaded. */
  natural: Size | null
  /** The stage's box. */
  stage: Size
  /** The stage the wheel, the drag and the double-click act on. */
  element: HTMLElement | null
  /** The room the fit leaves on each side of the stage. */
  margin: number
  /** A hairline edge, kept one pixel wide however far the picture is zoomed. */
  edge?: boolean
  /** A picture on its way out takes no presses. */
  disabled?: boolean
}

export interface PictureZoom {
  /** The picture the camera draws; it takes the hook's ref. */
  picture: RefObject<HTMLImageElement | null>
  /** The picture's buttons and keys, ready once its size is known. */
  controls: PictureControls | null
  /** The zoom and the fit it is measured against; null until the picture's size is known. */
  zoom: { z: number; fit: number } | null
  zoomed: boolean
  dragging: boolean
}

/**
 * A picture that zooms and pans on its stage: a pinch or the wheel with Mod zooms around the
 * pointer, the wheel and a drag pan it once zoomed, and a double-click toggles the fit and 100%.
 * The stage element takes the wheel and the pointer, once it mounts.
 */
export function usePictureZoom({
  natural,
  stage,
  element,
  margin,
  edge,
  disabled = false,
}: PictureZoomOptions): PictureZoom {
  const [zoom, setZoom] = useState<{ z: number; fit: number } | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const picture = useRef<HTMLImageElement>(null)
  const camera = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const fit = useRef(1)
  const glideTo = useRef<AnimationPlaybackControls | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gesture = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const draw = useCallback(() => {
    const el = picture.current
    if (!el) return
    const { x, y, z } = camera.current
    el.style.transform = `translate(${x}px, ${y}px) scale(${z})`
    el.style.imageRendering = z >= PIXELATED_FROM ? 'pixelated' : ''
    el.style.willChange = 'transform'
    if (edge) el.style.boxShadow = `0 0 0 calc(var(--hairline) / ${z}) var(--border-default)`
    clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      if (picture.current) picture.current.style.willChange = ''
    }, SETTLE_MS)
    setZoomed(isZoomed(camera.current, fit.current))
    // The zoom is shown to whole percent: a pan, which leaves it as it was, re-renders nothing.
    setZoom((previous) =>
      previous &&
      previous.fit === fit.current &&
      Math.round(previous.z * 100) === Math.round(z * 100)
        ? previous
        : { z, fit: fit.current },
    )
  }, [picture, edge])

  const place = useCallback(
    (next: Camera) => {
      glideTo.current?.stop()
      camera.current = next
      draw()
    },
    [draw],
  )

  /** A move a button or key asks for: an ease over --duration-fast, or at once under reduce motion. */
  const moveTo = useCallback(
    (target: Camera) => {
      glideTo.current?.stop()
      if (prefersReducedMotion()) return place(target)
      const start = camera.current
      glideTo.current = animate(0, 1, {
        ...follow,
        onUpdate: (k) => {
          // The zoom on a log scale, so a step feels the same at every level.
          const z = Math.exp(Math.log(start.z) + (Math.log(target.z) - Math.log(start.z)) * k)
          camera.current = {
            z,
            x: start.x + (target.x - start.x) * k,
            y: start.y + (target.y - start.y) * k,
          }
          draw()
        },
      })
    },
    [place, draw],
  )

  const at = useCallback(
    (z: number, px = 0, py = 0): Camera =>
      natural ? zoomAt(camera.current, z, px, py, natural, stage, fit.current) : camera.current,
    [natural, stage],
  )

  const bounds = useCallback(
    (next: Camera) => (natural ? bounded(next, natural, stage, fit.current) : next),
    [natural, stage],
  )

  const controls: PictureControls | null = useMemo(
    () =>
      natural
        ? {
            zoomBy: (direction) =>
              moveTo(snapped(at(stepZoom(camera.current.z, direction, fit.current)), fit.current)),
            fit: () => moveTo({ x: 0, y: 0, z: fit.current }),
            actual: () => moveTo(at(1)),
            toggle: () => moveTo(toggled(camera.current, 0, 0, natural, stage, fit.current)),
          }
        : null,
    [at, moveTo, natural, stage],
  )

  // The fit follows the stage; a picture at its fit stays fitted, a zoomed one in its bounds.
  useLayoutEffect(() => {
    if (!natural || stage.width === 0) return
    const before = fit.current
    fit.current = fitZoom(natural, stage, margin)
    const fitted = !isZoomed(camera.current, before)
    camera.current = fitted
      ? { x: 0, y: 0, z: fit.current }
      : bounded(camera.current, natural, stage, fit.current)
    draw()
  }, [natural, stage, margin, draw])

  useEffect(
    () => () => {
      glideTo.current?.stop()
      clearTimeout(settle.current)
      clearTimeout(gesture.current)
    },
    [],
  )

  // A picture on its way out keeps its camera where the item's own flight leaves it.
  useEffect(() => {
    if (disabled) glideTo.current?.stop()
  }, [disabled])

  // The wheel pans a zoomed picture, and zooms around the pointer with Mod or a pinch, which
  // Chromium sends as Ctrl and the wheel.
  useEffect(() => {
    if (!element || !natural) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.height : 1
      const current = camera.current
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect()
        const delta = Math.max(-50, Math.min(50, event.deltaY * unit))
        place(
          zoomAt(
            current,
            current.z * Math.exp(-delta * 0.01),
            event.clientX - rect.left - rect.width / 2,
            event.clientY - rect.top - rect.height / 2,
            natural,
            stage,
            fit.current,
          ),
        )
        clearTimeout(gesture.current)
        gesture.current = setTimeout(() => {
          const settled = snapped(camera.current, fit.current)
          if (settled !== camera.current) moveTo(settled)
        }, GESTURE_END_MS)
      } else if (isZoomed(current, fit.current)) {
        place(
          bounds({
            ...current,
            x: current.x - event.deltaX * unit,
            y: current.y - event.deltaY * unit,
          }),
        )
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [element, natural, stage, place, moveTo, bounds])

  // A drag pans a zoomed picture once it passes the slop.
  useEffect(() => {
    if (!element || !natural) return
    const overPicture = (x: number, y: number) => {
      const box = picture.current?.getBoundingClientRect()
      return !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    }
    let press: { x: number; y: number; camera: Camera; moved: boolean } | null
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || disabled) return
      press = { x: event.clientX, y: event.clientY, camera: camera.current, moved: false }
      // A pointer captured on the stage keeps sending its moves once the drag leaves it.
      if (overPicture(event.clientX, event.clientY) && isZoomed(camera.current, fit.current)) {
        element.setPointerCapture(event.pointerId)
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!press || !isZoomed(press.camera, fit.current)) return
      const dx = event.clientX - press.x
      const dy = event.clientY - press.y
      if (!press.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
        press.moved = true
        setDragging(true)
      }
      if (press.moved)
        place(bounds({ ...press.camera, x: press.camera.x + dx, y: press.camera.y + dy }))
    }
    const onPointerUp = () => {
      press = null
      setDragging(false)
    }
    const onPointerCancel = () => {
      press = null
      setDragging(false)
    }
    const onDoubleClick = (event: MouseEvent) => {
      if (disabled || !overPicture(event.clientX, event.clientY)) return
      const rect = element.getBoundingClientRect()
      moveTo(
        toggled(
          camera.current,
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
          natural,
          stage,
          fit.current,
        ),
      )
    }
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    element.addEventListener('pointercancel', onPointerCancel)
    element.addEventListener('dblclick', onDoubleClick)
    return () => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerCancel)
      element.removeEventListener('dblclick', onDoubleClick)
    }
  }, [element, natural, stage, disabled, picture, place, moveTo, bounds])

  return { picture, controls, zoom, zoomed, dragging }
}
