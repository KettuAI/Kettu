import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, motion, useIsPresent } from 'motion/react'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { DEFAULT_PICTURE_SIZE, usePictureZoom, type PictureControls } from './picture-zoom'
import { flight, inView, placeBox, placeOf, type Box } from './viewer-motion'
import { FIT_MARGIN, type Size } from './zoom'

/** What an item shows once its source is known. */
export type Shown =
  | { state: 'loading' }
  | { state: 'ready'; kind: 'image' | 'video'; src: string }
  | { state: 'failed'; message: string }

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

const STEP = {
  enter: (direction: number) => ({ opacity: 0, x: prefersReducedMotion() ? 0 : 24 * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: prefersReducedMotion() ? 0 : -24 * direction }),
}

/** A press that moves less than this is a click on the scrim. */
const CLICK_SLOP = 4

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
  const clip = useRef<HTMLVideoElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null)
  // The stage's own element, which the picture's wheel, drag and double-click act on.
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    root.current = el
    setStageElement(el)
  }, [])
  const flown = useRef(false)
  // A place hidden while its item flies to or from it, shown again however the flight ends.
  const hidden = useRef<HTMLElement | null>(null)
  const image = shown.state === 'ready' && shown.kind === 'image'

  const hide = (place: HTMLElement | null) => {
    if (hidden.current) hidden.current.style.visibility = ''
    hidden.current = place
    if (place) place.style.visibility = 'hidden'
  }

  const { picture, controls, zoom, zoomed, dragging } = usePictureZoom({
    natural: image ? natural : null,
    stage,
    element: stageElement,
    margin: FIT_MARGIN,
    disabled: leaving,
  })

  useEffect(() => {
    if (!controls) return
    onControls(itemKey, controls)
    return () => onControls(itemKey, null)
  }, [controls, onControls, itemKey])

  useEffect(() => {
    if (zoom && image) onView(itemKey, { pixels: natural, zoom })
  }, [zoom, image, natural, onView, itemKey])

  useEffect(
    () => () => {
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

  // A press released unmoved beside the picture or the clip, on the scrim, closes the viewer.
  const press = useRef<{ x: number; y: number; moved: boolean; onItem: boolean } | null>(null)
  const overItem = (x: number, y: number) => {
    const el = picture.current ?? clip.current
    if (!el) return false
    const box = el.getBoundingClientRect()
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
  }

  return (
    <motion.div
      ref={stageRef}
      custom={direction}
      variants={STEP}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: SLOW, ease: EASE }}
      className={cn('absolute inset-0 overflow-hidden', !present && 'pointer-events-none')}
      onPointerDown={(event) => {
        if (event.button !== 0 || leaving) return
        press.current = {
          x: event.clientX,
          y: event.clientY,
          moved: false,
          onItem: overItem(event.clientX, event.clientY),
        }
      }}
      onPointerMove={(event) => {
        const held = press.current
        if (!held) return
        if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > CLICK_SLOP)
          held.moved = true
      }}
      onPointerUp={() => {
        const held = press.current
        press.current = null
        if (!held || held.moved || leaving) return
        if (!held.onItem) onBackground()
      }}
      onPointerCancel={() => {
        press.current = null
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
                        : DEFAULT_PICTURE_SIZE,
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
