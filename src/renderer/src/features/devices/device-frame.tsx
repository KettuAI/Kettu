import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DeviceFrame as Frame,
  DeviceFrameButton,
  DeviceOrientation,
} from '@shared/device-host'
import { cn } from '@renderer/lib/utils'

type Size = { width: number; height: number }
type Rect = Size & { x: number; y: number }

/** Bezel and screen corner of the plain frame, as parts of the screen's shorter side. */
const PLAIN_BEZEL = 0.045
const PLAIN_CORNER = 0.09

interface Layout {
  /** The upright device, in its own units. */
  width: number
  height: number
  screen: Rect
  radii: [number, number, number, number]
  /** Clockwise degrees the device is turned on screen. */
  turn: number
  body: number | null
}

/**
 * How far the device turns: a simulator's picture stays portrait when it rotates, as Simulator
 * shows it, while an Android picture already arrives turned.
 */
function turnOf(orientation: DeviceOrientation, picture: Size): number {
  if (picture.width > picture.height) return 0
  switch (orientation) {
    case 'landscape_left':
      return 90
    case 'landscape_right':
      return -90
    case 'portrait_upside_down':
      return 180
    default:
      return 0
  }
}

function layoutOf(frame: Frame | null, picture: Size, orientation: DeviceOrientation): Layout {
  const turn = turnOf(orientation, picture)
  if (frame) {
    return {
      width: frame.width,
      height: frame.height,
      screen: frame.screen,
      radii: frame.radii,
      turn,
      body: null,
    }
  }
  const short = Math.min(picture.width, picture.height)
  const bezel = short * PLAIN_BEZEL
  const corner = short * PLAIN_CORNER
  return {
    width: picture.width + bezel * 2,
    height: picture.height + bezel * 2,
    screen: { x: bezel, y: bezel, ...picture },
    radii: [corner, corner, corner, corner],
    turn,
    body: corner + bezel,
  }
}

function dataUrl(png: ArrayBuffer): string {
  const bytes = new Uint8Array(png)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:image/png;base64,${btoa(binary)}`
}

/**
 * The device around its screen, fitted into `room`: Xcode's own frame for a simulator, else a
 * plain one. The whole device turns with the screen, so the picture inside reads upright.
 */
export function DeviceFrame({
  frame,
  picture,
  orientation,
  room,
  focused,
  glow = false,
  onButton,
  className,
  children,
}: {
  frame: Frame | null
  /** The size of the pictures the device streams. */
  picture: Size
  orientation: DeviceOrientation
  room: Size
  focused: boolean
  /** An agent drives the device: the fox glows along the screen's edge. */
  glow?: boolean
  /** A button on the frame went down or up. */
  onButton?: (name: string, phase: 'down' | 'up') => void
  className?: string
  children: ReactNode
}) {
  const layout = layoutOf(frame, picture, orientation)
  const sideways = Math.abs(layout.turn) === 90
  const shown = sideways
    ? { width: layout.height, height: layout.width }
    : { width: layout.width, height: layout.height }
  const scale = Math.max(0, Math.min(room.width / shown.width, room.height / shown.height))
  const images = useMemo(
    () =>
      frame?.images.map((image) => ({
        ...image,
        src: dataUrl(image.png),
        downSrc: image.button?.down ? dataUrl(image.button.down) : null,
      })) ?? [],
    [frame],
  )
  const px = (value: number): number => value * scale
  const place = (rect: Rect) => ({
    left: px(rect.x),
    top: px(rect.y),
    width: px(rect.width),
    height: px(rect.height),
  })

  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: Math.floor(px(shown.width)), height: Math.floor(px(shown.height)) }}
    >
      <div
        className="absolute top-1/2 left-1/2"
        style={{
          width: px(layout.width),
          height: px(layout.height),
          transform: `translate(-50%, -50%) rotate(${layout.turn}deg)`,
        }}
      >
        {layout.body !== null && (
          <div
            aria-hidden
            className="absolute inset-0 bg-(--pane-phone) shadow-[0_0_0_var(--hairline)_var(--border-default),inset_0_0_0_1.5px_var(--pane-phone-edge)]"
            style={{ borderRadius: px(layout.body) }}
          />
        )}
        {images.map((image, index) =>
          image.button && onButton ? (
            <FrameButton
              key={index}
              button={image.button}
              src={image.src}
              downSrc={image.downSrc}
              style={place(image)}
              onButton={onButton}
            />
          ) : (
            <img
              key={index}
              alt=""
              aria-hidden
              draggable={false}
              src={image.src}
              className="pointer-events-none absolute select-none"
              style={place(image)}
            />
          ),
        )}
        <div
          className={cn(
            'absolute overflow-hidden bg-(--pane-phone)',
            focused && 'ring-2 ring-focus',
          )}
          style={{
            ...place(layout.screen),
            borderRadius: layout.radii.map((radius) => `${px(radius)}px`).join(' '),
          }}
        >
          {children}
          {glow && <span aria-hidden className="kp-screen-glow" />}
        </div>
      </div>
    </div>
  )
}

function labelKey(name: string) {
  switch (name) {
    case 'volume-up':
      return 'buttons.volumeUp'
    case 'volume-down':
      return 'buttons.volumeDown'
    case 'power':
    case 'side-button':
      return 'buttons.side'
    case 'action':
      return 'buttons.action'
    default:
      return 'buttons.other'
  }
}

/**
 * A hardware button on the frame, as Xcode's Simulator has it: it slides out by its rollover
 * travel under the pointer, shows its pressed picture while held, and is held on the device
 * from pointer down to up, so a long press works.
 */
function FrameButton({
  button,
  src,
  downSrc,
  style,
  onButton,
}: {
  button: DeviceFrameButton
  src: string
  downSrc: string | null
  style: CSSProperties
  onButton: (name: string, phase: 'down' | 'up') => void
}) {
  const { t } = useTranslation('devices')
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const held = useRef(false)
  const latest = useRef(onButton)
  useEffect(() => {
    latest.current = onButton
  })

  // A button held when the frame goes away must not stay down on the device.
  useEffect(
    () => () => {
      if (held.current) latest.current(button.name, 'up')
    },
    [button.name],
  )

  const release = (): void => {
    if (!held.current) return
    held.current = false
    setPressed(false)
    onButton(button.name, 'up')
  }

  const out = hovered || pressed
  return (
    <div
      role="button"
      aria-label={t(labelKey(button.name))}
      aria-pressed={pressed}
      className="absolute touch-none transition-[translate] duration-(--duration-fast) ease-(--ease-standard) select-none motion-reduce:transition-none"
      style={{
        ...style,
        translate: out ? `${button.hover.x * 100}% ${button.hover.y * 100}%` : undefined,
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        held.current = true
        setPressed(true)
        onButton(button.name, 'down')
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <img
        alt=""
        aria-hidden
        draggable={false}
        src={pressed && downSrc ? downSrc : src}
        className={cn(
          'pointer-events-none absolute inset-0 size-full select-none',
          pressed && !downSrc && 'brightness-125',
        )}
      />
    </div>
  )
}
