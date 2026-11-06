import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DeviceFrame as Frame,
  DeviceInfo,
  DeviceInput,
  DeviceOrientation,
  DeviceScreen as Screen,
} from '@shared/device-host'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { DeviceFrame } from './device-frame'

type StreamState = 'starting' | 'live' | 'stopped' | 'error'

/** Keys that are not text: sent by their code, the rest arrives as text through the field. */
const KEY_CODES = new Set([
  'Enter',
  'NumpadEnter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const FRAME_US = 16_667
/** Without hardware decoding, as on a page opened over plain http, a picture this often. */
const STILL_EVERY_MS = 1_000
const NO_ROOM = { width: 0, height: 0 }
const canDecode = typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'

function avcCodec(description: Uint8Array): string {
  const hex = (byte: number): string => byte.toString(16).padStart(2, '0')
  return `avc1.${hex(description[1] ?? 0x42)}${hex(description[2] ?? 0xe0)}${hex(description[3] ?? 0x1e)}`
}

function send(deviceId: string, input: DeviceInput): void {
  void window.kettu.devices.request('devices.input', { deviceId, input }).catch(() => undefined)
}

/**
 * One device's live screen: the host's encoded frames decoded on the GPU and drawn to a canvas,
 * acknowledged as they are drawn, with the pointer as a finger and the keyboard as the device's.
 */
export function DeviceScreen({ device, className }: { device: DeviceInfo; className?: string }) {
  const { t } = useTranslation('devices')
  const canvas = useRef<HTMLCanvasElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const [state, setState] = useState<StreamState>('starting')
  const [error, setError] = useState<string | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [focused, setFocused] = useState(false)
  const pointer = useRef<{ id: number; pinch: boolean } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [picture, setPicture] = useState<{ width: number; height: number }>(() =>
    device.platform === 'ios' ? { width: 1179, height: 2556 } : { width: 1080, height: 2400 },
  )
  const [orientation, setOrientation] = useState<DeviceOrientation>('portrait')
  // Undefined until the host answers; a simulator's frame comes once its stream runs.
  const [frame, setFrame] = useState<Frame | null | undefined>(undefined)
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null)
  const id = device.id
  const ownFrame = device.platform === 'ios' && device.kind === 'simulator'
  const ready = room !== null && (!ownFrame || frame !== undefined)

  // The device keeps its aspect ratio inside whatever room the pane gives it.
  useEffect(() => {
    const element = box.current
    if (!element) return
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0) setRoom({ width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let decoder: VideoDecoder | null = null
    let screen: Screen | null = null
    let description: Uint8Array | null = null
    let waitingKey = true
    let timestamp = 0
    let drewFrame = false
    let ackSeq = 0
    let ackQueued = false
    let closed = false
    let framed = false

    const loadFrame = (): void => {
      if (framed) return
      framed = true
      window.kettu.devices
        .request('devices.frame', { deviceId: id })
        .then((result) => {
          if (!closed) setFrame(result.frame)
        })
        .catch(() => {
          if (!closed) setFrame(null)
        })
    }

    const draw = (source: CanvasImageSource, width: number, height: number): void => {
      const element = canvas.current
      if (!element) return
      if (element.width !== width || element.height !== height) {
        element.width = width
        element.height = height
        setPicture({ width, height })
      }
      element.getContext('2d')?.drawImage(source, 0, 0, width, height)
    }

    const ack = (seq: number): void => {
      ackSeq = Math.max(ackSeq, seq)
      if (ackQueued) return
      ackQueued = true
      // Not a frame callback: a window out of front paints nothing but still decodes.
      setTimeout(() => {
        ackQueued = false
        if (!closed) {
          void window.kettu.devices
            .request('devices.ack', { deviceId: id, seq: ackSeq })
            .catch(() => undefined)
        }
      }, 0)
    }

    const configure = (): void => {
      if (!description || !canDecode) return
      const codec = screen?.codec ?? avcCodec(description)
      decoder?.close()
      decoder = new VideoDecoder({
        output: (frame) => {
          draw(frame, frame.displayWidth, frame.displayHeight)
          frame.close()
          if (!drewFrame) {
            drewFrame = true
            setDrawn(true)
          }
        },
        error: (reason) => {
          setError(reason.message)
          waitingKey = true
          configure()
        },
      })
      decoder.configure({
        codec,
        description,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
      })
      waitingKey = true
    }

    const unsubscribe = window.kettu.devices.onEvent((event) => {
      if (!('deviceId' in event) || event.deviceId !== id) return
      if (event.type === 'device.screen') {
        const changed = event.screen.codec !== screen?.codec
        screen = event.screen
        setOrientation(event.screen.orientation)
        if (changed && description) configure()
      } else if (event.type === 'device.stream') {
        setState(event.state)
        setError(event.error ?? null)
      } else if (event.type === 'device.frame') {
        const data = new Uint8Array(event.data)
        if (event.kind === 'seed') {
          if (!drewFrame) {
            void createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
              .then((bitmap) => {
                if (!drewFrame) draw(bitmap, bitmap.width, bitmap.height)
                bitmap.close()
              })
              .catch(() => undefined)
          }
          ack(event.seq)
          return
        }
        if (event.kind === 'description') {
          description = data
          configure()
          ack(event.seq)
          return
        }
        if (!decoder || decoder.state !== 'configured') return ack(event.seq)
        if (waitingKey && event.kind !== 'key') return ack(event.seq)
        waitingKey = false
        timestamp += FRAME_US
        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: event.kind === 'key' ? 'key' : 'delta',
              timestamp,
              data,
            }),
          )
        } catch {
          waitingKey = true
        }
        setState('live')
        ack(event.seq)
      }
    })

    // The browser gives no decoder: screenshots instead, which take no stream at all.
    let stills: ReturnType<typeof setInterval> | null = null
    if (!canDecode) {
      const still = (): void => {
        void window.kettu.devices
          .request('devices.screenshot', { deviceId: id })
          .then(async ({ png }) => {
            if (closed) return
            const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
            draw(bitmap, bitmap.width, bitmap.height)
            bitmap.close()
            loadFrame()
            if (!drewFrame) {
              drewFrame = true
              setDrawn(true)
            }
          })
          .catch(() => undefined)
      }
      still()
      stills = setInterval(still, STILL_EVERY_MS)
      return () => {
        closed = true
        unsubscribe()
        if (stills) clearInterval(stills)
      }
    }

    const watch = (): void => {
      window.kettu.devices
        .request('devices.watch', { deviceId: id })
        .then((result) => {
          if (result.screen) {
            screen = result.screen
            setOrientation(result.screen.orientation)
          }
          loadFrame()
        })
        .catch((reason: unknown) => {
          setState('error')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
    }
    watch()
    // A device host that restarted knows no watcher: watch again once its port is back.
    let lost = false
    const stopConnection = window.kettu.devices.onConnection((connection) => {
      if (connection !== 'connected') lost = true
      else if (lost) {
        lost = false
        waitingKey = true
        watch()
      }
    })
    const stopRestarted = window.kettu.devices.onEvent((event) => {
      if (event.type === 'devices.restarted') {
        waitingKey = true
        watch()
      }
    })

    return () => {
      closed = true
      unsubscribe()
      stopConnection()
      stopRestarted()
      decoder?.close()
      void window.kettu.devices.request('devices.unwatch', { deviceId: id }).catch(() => undefined)
    }
  }, [id])

  const point = (event: PointerEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const clamp = (value: number): number => Math.min(1, Math.max(0, value))
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    }
  }

  const fingers = device.platform === 'android' || device.kind === 'physical'

  const touch = (event: PointerEvent<HTMLCanvasElement>, phase: 'begin' | 'move' | 'end'): void => {
    const { x, y } = point(event)
    send(id, { type: 'touch', phase, x, y, finger: 0 })
    // Option and a drag pinch: a second finger mirrored around the screen's center.
    if (pointer.current?.pinch) send(id, { type: 'touch', phase, x: 1 - x, y: 1 - y, finger: 1 })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.metaKey || event.ctrlKey) return
    if (KEY_CODES.has(event.code)) {
      event.preventDefault()
      send(id, { type: 'key', phase: 'down', code: event.code })
    }
  }

  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return
    if (KEY_CODES.has(event.code)) send(id, { type: 'key', phase: 'up', code: event.code })
  }

  const flushText = (): void => {
    const element = field.current
    if (!element || !element.value) return
    send(id, { type: 'text', text: element.value })
    element.value = ''
  }

  const status = drawn ? null : state === 'error' ? (
    <span className="max-w-60 px-4 text-center">{error ?? t('screen.error')}</span>
  ) : state === 'stopped' ? (
    <span>{t('screen.stopped')}</span>
  ) : (
    <>
      <Spinner />
      <span>{t('screen.starting')}</span>
    </>
  )

  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1 p-6', className)}>
      <div ref={box} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <DeviceFrame
          className={cn(!ready && 'invisible')}
          frame={frame ?? null}
          picture={picture}
          orientation={orientation}
          room={room ?? NO_ROOM}
          focused={focused}
        >
          <canvas
            ref={canvas}
            width={device.platform === 'ios' ? 1179 : 1080}
            height={device.platform === 'ios' ? 2556 : 2400}
            aria-label={t('screen.label', { name: device.name })}
            className="block size-full touch-none select-none"
            onPointerDown={(event) => {
              // The mouse down that follows would move focus off the keyboard field.
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              pointer.current = { id: event.pointerId, pinch: fingers && event.altKey }
              touch(event, 'begin')
              field.current?.focus()
            }}
            onPointerMove={(event) => {
              if (pointer.current?.id === event.pointerId) touch(event, 'move')
            }}
            onPointerUp={(event) => {
              if (pointer.current?.id !== event.pointerId) return
              touch(event, 'end')
              pointer.current = null
            }}
            onPointerCancel={(event) => {
              if (pointer.current?.id !== event.pointerId) return
              touch(event, 'end')
              pointer.current = null
            }}
            onWheel={(event) => {
              const { x, y } = point(event)
              send(id, { type: 'scroll', x, y, dx: event.deltaX, dy: event.deltaY })
            }}
          />
          {ready && status && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-hint text-(--media-control)">
              {status}
            </div>
          )}
        </DeviceFrame>
        {!ready && status && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-hint text-secondary">
            {status}
          </div>
        )}
      </div>
      {!canDecode && (
        <p className="absolute inset-x-0 top-2 text-center text-small text-tertiary">
          {t('screen.limited')}
        </p>
      )}
      {/* The keyboard goes to the device through this field, so input methods compose as usual. */}
      <textarea
        ref={field}
        aria-label={t('screen.keyboard', { name: device.name })}
        className="pointer-events-none absolute size-px opacity-0"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onInput={(event) => {
          if (!(event.nativeEvent as InputEvent).isComposing) flushText()
        }}
        onCompositionEnd={flushText}
        onPaste={(event) => {
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          if (text) send(id, { type: 'text', text })
        }}
      />
    </div>
  )
}
