import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, motion, useIsPresent, type AnimationPlaybackControls } from 'motion/react'
import { Spinner } from '@renderer/components/ui/spinner'
import { follow } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { flight, inView, placeBox, placeOf, type Box } from './viewer-motion'
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

/** What an item shows once its source is known. */
export type Shown =
  | { state: 'loading' }
  | { state: 'ready'; kind: 'image' | 'video'; src: string }
  | { state: 'failed'; message: string }

/** What the bar's zoom buttons and keys do to the picture on the stage. */
export interface PictureControls {
  zoomBy(direction: 1 | -1): void
  fit(): void
  actual(): void
  toggle(): void
}

/** What the bar shows of the item: its pixels and, for a picture, its zoom and fit. */
export interface ItemView {
  pixels: Size | null
  zoom: { z: number; fit: number } | null
}

const EASE = [0.165, 0.84, 0.44, 1] as const
/** --duration-slow, the item's flight and a step's slide. */
const SLOW = 0.3
/** --duration-fast, a fade when the place is out of view. */
const FAST = 0.12
/** A press that moves less than this is a click. */
const DRAG_SLOP = 4
/** The picture keeps `will-change` this long after the camera stops, then draws crisp again. */
const SETTLE_MS = 160
/** A wheel or pinch zoom has ended once no event came for this long. */
const GESTURE_END_MS = 150
/** The size an image without one of its own, such as an SVG with only a viewBox, takes. */
const DEFAULT_SIZE = { width: 300, height: 150 }

const STEP = {
  enter: (direction: number) => ({ opacity: 0, x: prefersReducedMotion() ? 0 : 24 * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: prefersReducedMotion() ? 0 : -24 * direction }),
}

const relative = (box: DOMRect | Box, to: DOMRect): Box => ({
  x: box.x - to.x,
  y: box.y - to.y,
  width: box.width,
  height: box.height,
})

/**
 * One item on the viewer's stage: a picture that zooms and pans, or a clip with Chromium's
 * controls. The item it opens on grows from `from`, its place; leaving, an item goes back to its
 * place when that is in view and fades otherwise, then calls `onLeft`.
 */
export function StageItem({
  itemKey,
  alt,
  shown,
  stage,
  direction,
  from,
  leaving,
  onLeft,
  onView,
  onBackground,
  onFailed,
  onControls,
  onVideoReady,
}: {
  itemKey: string
  alt: string
  shown: Shown
  stage: Size
  /** Where a step came from: 1 for the next item, -1 for the previous one. */
  direction: number
  from: HTMLElement | null
  leaving: boolean
  onLeft: () => void
  onView: (key: string, view: ItemView) => void
  /** A click on the scrim beside the item. */
  onBackground: () => void
  /** The picture or clip failed to load; null when its format cannot show here. */
  onFailed: (message: string | null) => void
  /** The picture's controls once it shows, and null when it no longer does. */
  onControls: (key: string, controls: PictureControls | null) => void
  onVideoReady: (element: HTMLVideoElement) => void
}) {
  const present = useIsPresent()
  const root = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const clip = useRef<HTMLVideoElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [dragging, setDragging] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const camera = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const fit = useRef(1)
  const glideTo = useRef<AnimationPlaybackControls | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gesture = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flown = useRef(false)
  // A place hidden while its item flies to or from it, shown again however the flight ends.
  const hidden = useRef<HTMLElement | null>(null)
  const image = shown.state === 'ready' && shown.kind === 'image'

  const hide = (place: HTMLElement | null) => {
    if (hidden.current) hidden.current.style.visibility = ''
    hidden.current = place
    if (place) place.style.visibility = 'hidden'
  }

  const draw = useCallback(() => {
    const el = picture.current
    if (!el) return
    const { x, y, z } = camera.current
    el.style.transform = `translate(${x}px, ${y}px) scale(${z})`
    el.style.imageRendering = z >= PIXELATED_FROM ? 'pixelated' : ''
    el.style.willChange = 'transform'
    clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      if (picture.current) picture.current.style.willChange = ''
    }, SETTLE_MS)
    setZoomed(isZoomed(camera.current, fit.current))
    onView(itemKey, { pixels: natural, zoom: { z, fit: fit.current } })
  }, [natural, onView, itemKey])

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

  const bounds = useCallback(
    (next: Camera) => (natural ? bounded(next, natural, stage, fit.current) : next),
    [natural, stage],
  )

  useEffect(() => {
    if (!image || !natural) return
    const at = (z: number) => zoomAt(camera.current, z, 0, 0, natural, stage, fit.current)
    onControls(itemKey, {
      zoomBy: (direction) =>
        moveTo(snapped(at(stepZoom(camera.current.z, direction, fit.current)), fit.current)),
      fit: () => moveTo({ x: 0, y: 0, z: fit.current }),
      actual: () => moveTo(at(1)),
      toggle: () => moveTo(toggled(camera.current, 0, 0, natural, stage, fit.current)),
    })
    return () => onControls(itemKey, null)
  }, [image, natural, stage, moveTo, onControls, itemKey])

  // The fit follows the stage; a picture at its fit stays fitted, a zoomed one in its bounds.
  useLayoutEffect(() => {
    if (!image || !natural || stage.width === 0) return
    const before = fit.current
    fit.current = fitZoom(natural, stage)
    const fitted = !isZoomed(camera.current, before) || !flown.current
    camera.current = fitted
      ? { x: 0, y: 0, z: fit.current }
      : bounded(camera.current, natural, stage, fit.current)
    draw()
  }, [image, natural, stage, draw])

  useEffect(
    () => () => {
      glideTo.current?.stop()
      clearTimeout(settle.current)
      clearTimeout(gesture.current)
      if (hidden.current) hidden.current.style.visibility = ''
    },
    [],
  )

  // In once the item can show: from its place for the one the viewer opened on, else a fade.
  useLayoutEffect(() => {
    const el = layer.current
    const stageBox = root.current?.getBoundingClientRect()
    if (!el || !stageBox || !natural || stage.width === 0 || flown.current || leaving) return
    flown.current = true
    const shownBox = picture.current ?? clip.current
    if (!from || !shownBox || prefersReducedMotion()) {
      el.style.opacity = '1'
      void animate(el, { opacity: [0, 1] }, { duration: from ? 0.2 : FAST })
      return
    }
    const { box, covers } = placeBox(from)
    const move = flight(
      relative(box, stageBox),
      relative(shownBox.getBoundingClientRect(), stageBox),
      stage,
      covers,
    )
    hide(from)
    el.style.opacity = '1'
    void animate(
      el,
      {
        x: [move.x, 0],
        y: [move.y, 0],
        scale: [move.scale, 1],
        ...(move.clip && move.full ? { clipPath: [move.clip, move.full] } : {}),
      },
      { duration: SLOW, ease: EASE },
    ).then(() => {
      if (hidden.current === from) hide(null)
      el.style.clipPath = ''
    })
    // Once, when the item first shows; later changes of the stage move the camera instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural, stage.width])

  // Leaving with the viewer: back to the place, or a fade when it is out of view.
  useEffect(() => {
    if (!leaving) return
    const el = layer.current
    const stageBox = root.current?.getBoundingClientRect()
    const target = placeOf(itemKey)
    const shownBox = picture.current ?? clip.current
    glideTo.current?.stop()
    if (!el || !stageBox) return onLeft()
    if (!flown.current || !target || !shownBox || !inView(target) || prefersReducedMotion()) {
      void animate(el, { opacity: 0 }, { duration: FAST }).then(onLeft)
      return
    }
    const { box, covers } = placeBox(target)
    const move = flight(
      relative(box, stageBox),
      relative(shownBox.getBoundingClientRect(), stageBox),
      stage,
      covers,
    )
    hide(target)
    void animate(
      el,
      {
        x: [0, move.x],
        y: [0, move.y],
        scale: [1, move.scale],
        ...(move.clip && move.full ? { clipPath: [move.full, move.clip] } : {}),
      },
      { duration: SLOW, ease: EASE },
    ).then(() => {
      hide(null)
      onLeft()
    })
    // Once, as the viewer starts to close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving])

  // The wheel pans a zoomed picture, and zooms around the pointer with Mod or a pinch, which
  // Chromium sends as Ctrl and the wheel.
  useEffect(() => {
    const el = root.current
    if (!el || !image || !natural) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.height : 1
      const current = camera.current
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect()
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
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [image, natural, stage, place, moveTo, bounds])

  const press = useRef<{
    x: number
    y: number
    camera: Camera
    moved: boolean
    onItem: boolean
  } | null>(null)
  // By the point, since a captured pointer's events all target the stage.
  const overItem = (x: number, y: number) => {
    const el = picture.current ?? clip.current
    if (!el || !natural) return false
    const box = el.getBoundingClientRect()
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
  }

  return (
    <motion.div
      ref={root}
      custom={direction}
      variants={STEP}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: SLOW, ease: EASE }}
      className={cn('absolute inset-0 overflow-hidden', !present && 'pointer-events-none')}
      onPointerDown={(event) => {
        if (event.button !== 0 || leaving) return
        const onItem = overItem(event.clientX, event.clientY)
        press.current = {
          x: event.clientX,
          y: event.clientY,
          camera: camera.current,
          moved: false,
          onItem,
        }
        if (image && onItem && isZoomed(camera.current, fit.current)) {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }}
      onPointerMove={(event) => {
        const held = press.current
        if (!held || !image || !isZoomed(held.camera, fit.current)) return
        const dx = event.clientX - held.x
        const dy = event.clientY - held.y
        if (!held.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
          held.moved = true
          setDragging(true)
        }
        if (held.moved)
          place(bounds({ ...held.camera, x: held.camera.x + dx, y: held.camera.y + dy }))
      }}
      onPointerUp={() => {
        const held = press.current
        press.current = null
        setDragging(false)
        if (!held || held.moved || leaving) return
        if (!held.onItem) onBackground()
      }}
      onPointerCancel={() => {
        press.current = null
        setDragging(false)
      }}
      onDoubleClick={(event) => {
        if (!image || !natural || !overItem(event.clientX, event.clientY)) return
        const rect = event.currentTarget.getBoundingClientRect()
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
      }}
    >
      <div ref={layer} className="absolute inset-0 origin-top-left" style={{ opacity: 0 }}>
        {shown.state === 'ready' &&
          (shown.kind === 'image' ? (
            <img
              ref={picture}
              src={shown.src}
              alt={alt}
              decoding="async"
              draggable={false}
              onLoad={(event) => {
                const el = event.currentTarget
                el.decode().then(
                  () =>
                    setNatural(
                      el.naturalWidth > 0 && el.naturalHeight > 0
                        ? { width: el.naturalWidth, height: el.naturalHeight }
                        : DEFAULT_SIZE,
                    ),
                  () => onFailed(null),
                )
              }}
              onError={() => onFailed(null)}
              style={
                natural
                  ? {
                      width: natural.width,
                      height: natural.height,
                      marginLeft: -natural.width / 2,
                      marginTop: -natural.height / 2,
                    }
                  : { visibility: 'hidden' }
              }
              className={cn(
                'absolute top-1/2 left-1/2 max-w-none bg-card checkerboard select-none',
                zoomed && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
              )}
            />
          ) : (
            <div className="absolute inset-12 flex items-center justify-center">
              <video
                ref={clip}
                src={shown.src}
                controls
                controlsList="nodownload"
                preload="metadata"
                aria-label={alt}
                onLoadedMetadata={(event) => {
                  const el = event.currentTarget
                  // Chromium loads some formats, such as ProRes, with sound and a picture of 0 x 0.
                  if (el.videoWidth === 0 || el.videoHeight === 0) return onFailed(null)
                  const size = { width: el.videoWidth, height: el.videoHeight }
                  setNatural(size)
                  onView(itemKey, { pixels: size, zoom: null })
                  onVideoReady(el)
                }}
                onError={(event) => {
                  const error = event.currentTarget.error
                  onFailed(
                    error?.code === MediaError.MEDIA_ERR_NETWORK ? error.message || null : null,
                  )
                }}
                className="max-h-full max-w-full bg-card"
              />
            </div>
          ))}
      </div>
      {shown.state === 'loading' || (shown.state === 'ready' && !natural) ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-5 animate-in text-muted-foreground fade-in fill-mode-both delay-200 duration-(--duration-fast)" />
        </div>
      ) : shown.state === 'failed' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-12">
          <p className="max-w-md text-center text-ui break-words text-muted-foreground">
            {shown.message}
          </p>
        </div>
      ) : null}
    </motion.div>
  )
}
