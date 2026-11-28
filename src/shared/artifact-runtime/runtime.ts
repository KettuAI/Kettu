// The page runtime: the script Kettu runs first in every HTML file it serves from an artifact. It
// gives the page `kettu.use`, and for the editor outlines and reports the element the client
// points at and previews a style or text on it. The page only ever receives the client's messages;
// what it sends goes through one transport, which the server chose: a POST to its own origin on the
// desktop, or the port the web client hands it. Bundled on its own, it reaches nothing of Kettu's.

import type { RuntimeError } from '../artifact-capabilities'
import {
  PARAMS_ATTRIBUTE,
  paramCss,
  parseParams,
  validParamValue,
  type PageParam,
} from '../artifact-params'
import { capabilityNamespace, type CapabilityTransport } from './capabilities'
import { DECK_REPORT_EVENT } from './deck-sheet'
import { DOC_REPORT_EVENT } from './document-sheet'
import { findMarqueeElements, unionPageBoxes } from './marquee'
import {
  RUNTIME_PATH,
  RUNTIME_VERSION,
  type AnchorRectReport,
  type DriveMessage,
  type ElementStyle,
  type PageBox,
  type PageSelection,
  PAGE_ERRORS,
  PAGE_KEYS,
  type Pin,
  type RuntimeConfig,
} from './page-messages'

const USE_WAIT_MS = 10_000
const SOURCE = 'data-kettu-src'
const TEXT_CHARS = 200
/** Minimum interval between live anchor rect sync messages to stay well within host rate limits. */
const ANCHOR_SYNC_MIN_MS = 16
/** How long after the old page left the next version takes its scroll. */
const SCROLL_KEPT_MS = 10_000

type Message = Record<string, unknown> & { v: typeof RUNTIME_VERSION; id: string; kind: string }
// Read from the transport as it came, so every field is checked where it is used.
type Answer = {
  id?: unknown
  ok?: unknown
  value?: unknown
  error?: unknown
  event?: unknown
  done?: unknown
}

/**
 * The open pin anchored to the exact source element at `src`, if any: prefers the currently active
 * open pin on that element, otherwise the latest one. Resolved (`done`) and lost pins are ignored
 * so clicking an element with only resolved comments still starts a new draft.
 */
export function openPinForSource(pins: readonly Pin[], src: number | null): number | null {
  if (src === null) return null
  let fallback: number | null = null
  for (const pin of pins) {
    if (pin.src !== src || pin.kind === 'done' || pin.kind === 'lost') continue
    if (pin.active) return pin.n
    fallback = pin.n
  }
  return fallback
}

export function start(config: RuntimeConfig): void {
  // Taken before the page's own scripts run, which may replace them.
  const fetch = window.fetch.bind(window)
  const stringify = JSON.stringify
  const parse = JSON.parse
  const freeze = Object.freeze
  const parent = window.parent
  let counter = 0
  const nextId = (): string => `k${++counter}`

  // The transport.

  const waiting = new Map<string, (answer: Answer) => void>()
  let port: MessagePort | null = null
  const queued: Message[] = []

  function viaPort(message: Message): void {
    if (port) port.postMessage(message)
    else queued.push(message)
  }

  /** Sends one message and resolves with its one answer. */
  function request(message: Message): Promise<Answer> {
    if (config.transport === 'port') {
      return new Promise((resolve) => {
        waiting.set(message.id, (answer) => {
          waiting.delete(message.id)
          resolve(answer)
        })
        viaPort(message)
      })
    }
    return fetch(RUNTIME_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify(message),
    }).then((response) => response.json() as Promise<Answer>)
  }

  /** Sends a message whose answers arrive one by one until `done` or an error. */
  function streamed(message: Message, onAnswer: (answer: Answer) => void): () => void {
    let ended = false
    const end = (answer: Answer): void => {
      if (ended) return
      onAnswer(answer)
      if (answer.done === true || answer.ok === false) ended = true
    }
    if (config.transport === 'port') {
      waiting.set(message.id, (answer) => {
        end(answer)
        if (ended) waiting.delete(message.id)
      })
      viaPort(message)
      return () => {
        if (ended) return
        ended = true
        waiting.delete(message.id)
        viaPort({ v: RUNTIME_VERSION, id: message.id, kind: 'cancel' })
      }
    }
    const abort = new AbortController()
    void fetch(RUNTIME_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringify(message),
      signal: abort.signal,
    })
      .then(async (response) => {
        const reader = response.body?.getReader()
        if (!reader) return
        const decoder = new TextDecoder()
        let rest = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          rest += decoder.decode(value, { stream: true })
          let line: number
          while ((line = rest.indexOf('\n')) >= 0) {
            const text = rest.slice(0, line).trim()
            rest = rest.slice(line + 1)
            if (text) end(parse(text) as Answer)
          }
        }
        if (rest.trim()) end(parse(rest) as Answer)
        end({ ok: false, error: { code: 'failed', message: 'The stream ended' } })
      })
      .catch(() => end({ ok: false, error: { code: 'failed', message: 'The stream ended' } }))
    return () => {
      ended = true
      abort.abort()
    }
  }

  function failure(answer: Answer): Error & RuntimeError {
    const error = (answer as { error?: { code?: unknown; message?: unknown } }).error
    const failed = new Error(typeof error?.message === 'string' ? error.message : 'Failed')
    ;(failed as Error & { code?: string }).code =
      typeof error?.code === 'string' ? error.code : 'failed'
    return failed as Error & RuntimeError
  }

  const transport: CapabilityTransport = {
    call: (cap, op, args) =>
      request({ v: RUNTIME_VERSION, id: nextId(), kind: 'call', cap, op, args }).then((answer) => {
        if (answer.ok === true) return answer.value
        throw failure(answer)
      }),
    stream: (cap, op, args, onEvent, onEnd) =>
      streamed({ v: RUNTIME_VERSION, id: nextId(), kind: 'stream', cap, op, args }, (answer) => {
        if ('event' in answer) onEvent(answer.event)
        else if (answer.done === true) onEnd?.(null)
        else if (answer.ok === false) onEnd?.(failure(answer))
      }),
  }

  function use(cap: unknown): Promise<Readonly<Record<string, unknown>> | null> {
    if (typeof cap !== 'string') return Promise.resolve(null)
    const answer = request({ v: RUNTIME_VERSION, id: nextId(), kind: 'use', cap }).then(
      (answer) => {
        const value = answer.ok === true ? (answer.value as { ops?: unknown } | null) : null
        const ops =
          value && Array.isArray(value.ops)
            ? value.ops.filter((op) => typeof op === 'string')
            : null
        if (!ops) return null
        try {
          const namespace = capabilityNamespace(cap, ops as string[], transport)
          return namespace ? (freeze(namespace) as Readonly<Record<string, unknown>>) : null
        } catch {
          return null
        }
      },
      () => null,
    )
    const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), USE_WAIT_MS))
    return Promise.race([answer, late])
  }

  // The page's own uncaught errors, a few per load, for the client to show; what they say is the
  // page's, which the client checks and shows as text alone.
  const load = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    (b % 36).toString(36),
  ).join('')
  const reported = new Set<string>()
  function reportError(
    kind: 'error' | 'rejection',
    message: string,
    source: string | null,
    line: number | null,
    column: number | null,
  ): void {
    const key = `${kind}\0${message}\0${source}\0${line}\0${column}`
    if (reported.size >= PAGE_ERRORS || reported.has(key)) return
    reported.add(key)
    const error: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'page-error',
      path: config.path,
      load,
      error: { kind, message, source, line, column },
    }
    if (config.transport === 'port') viaPort(error)
    else void request(error).catch(() => {})
  }
  const sourceOf = (url: unknown): string | null => {
    if (typeof url !== 'string' || url === '') return null
    try {
      const parsed = new URL(url, location.href)
      return parsed.origin === location.origin ? parsed.pathname : url
    } catch {
      return null
    }
  }
  window.addEventListener('error', (event) => {
    // A file that failed to load fires here too, on its element, and is no script error.
    if (!(event instanceof ErrorEvent)) return
    const text =
      event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : event.message
    reportError('error', String(text ?? ''), sourceOf(event.filename), event.lineno, event.colno)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    let text: string
    try {
      text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
    } catch {
      text = 'Unhandled rejection'
    }
    reportError('rejection', text, null, null, null)
  })

  try {
    Object.defineProperty(window, 'kettu', {
      value: freeze({ version: RUNTIME_VERSION, use }),
      enumerable: false,
      configurable: false,
      writable: false,
    })
  } catch {
    // A page that defined its own `kettu` first keeps it.
  }

  // The overlay: outlines, the tag's label and comment pins, drawn over the page in a closed
  // shadow root after its body, so neither the page's styles nor its `body >` rules reach them.

  let host: HTMLElement | null = null
  let layer: ShadowRoot | null = null
  let hoverBox: HTMLElement | null = null
  let pickedBox: HTMLElement | null = null
  let multiLayer: HTMLElement | null = null
  let marqueeBox: HTMLElement | null = null
  let label: HTMLElement | null = null
  let pinLayer: HTMLElement | null = null

  function overlay(): void {
    if (host?.isConnected) return
    if (!host) {
      host = document.createElement('kettu-overlay')
      layer = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent =
        ':host{all:initial!important;position:fixed!important;inset:0!important;' +
        'pointer-events:none!important;z-index:2147483647!important;display:block!important}' +
        '.box{position:fixed;box-sizing:border-box;border-radius:3px;display:none}' +
        '.hover{border:1.5px dashed var(--accent)}' +
        '.picked{border:2px solid var(--accent);box-shadow:0 0 0 1px rgb(255 255 255 / 60%)}' +
        '.marquee{position:fixed;box-sizing:border-box;border-radius:3px;display:none;' +
        'border:1.5px solid var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}' +
        '.label{position:fixed;display:none;padding:1px 6px;border-radius:4px;' +
        'background:var(--accent);color:white;font:500 11px/16px system-ui,sans-serif;white-space:nowrap}' +
        '.pin{position:fixed;box-sizing:border-box;width:20px;height:20px;border-radius:50%;' +
        'background:var(--pin);color:var(--pin-text);font:600 11px/20px system-ui,sans-serif;' +
        // A hairline keeps a light badge, as dark mode draws it, apart from a light page.
        'text-align:center;box-shadow:0 0 0 1px rgb(0 0 0 / 14%),0 1px 3px rgb(0 0 0 / 30%)}' +
        '.pin.active{background:var(--accent);color:white;' +
        'box-shadow:0 0 0 2px var(--pin-ground),0 6px 16px rgb(0 0 0 / 35%)}' +
        '.pin.lost{background:var(--pin-ground);color:var(--pin);' +
        'outline:1.5px dashed var(--pin);outline-offset:-1.5px}' +
        '.pin.done{background:var(--pin-ground);color:var(--pin-done);' +
        'box-shadow:inset 0 0 0 1.5px var(--pin-done),0 1px 3px rgb(0 0 0 / 20%);line-height:18px}' +
        '.pin.lost.active,.pin.done.active{background:var(--accent);color:white;outline:none}'
      hoverBox = document.createElement('div')
      hoverBox.className = 'box hover'
      pickedBox = document.createElement('div')
      pickedBox.className = 'box picked'
      multiLayer = document.createElement('div')
      marqueeBox = document.createElement('div')
      marqueeBox.className = 'marquee'
      label = document.createElement('div')
      label.className = 'label'
      pinLayer = document.createElement('div')
      layer.append(style, pinLayer, multiLayer, hoverBox, pickedBox, marqueeBox, label)
    }
    host.style.setProperty('--accent', accent)
    for (const [name, value] of Object.entries(pinColors)) host.style.setProperty(name, value)
    document.documentElement.append(host)
  }

  // Select mode and what it shows.

  let mode: 'select' | 'comment' | null = null
  let channel = ''
  let accent = '#0060e2'
  // The pins' colors until the client sends its theme's.
  let pinColors: Record<string, string> = {
    '--pin': '#1f1f1f',
    '--pin-text': '#ffffff',
    '--pin-ground': '#ffffff',
    '--pin-done': '#2e7550',
  }
  let hovered: Element | null = null
  let picked: Element | null = null
  let pickedMany: Element[] = []
  let marqueeRect: PageBox | null = null
  let marqueeHits: Element[] = []
  let keepScroll = false
  let passKeys = false
  let pins: Pin[] = []
  // Where each pin was last drawn, for a pick that lands on one.
  let pinBoxes: { n: number; x: number; y: number }[] = []
  // The picked element's text as it was before typing in place began.
  let typing: { element: HTMLElement; before: string } | null = null
  let frame = 0
  // What a preview changed on the picked element, to put back.
  let original: { element: Element; style: string | null; text: string | null } | null = null
  // Live anchor tracking while a host popover is anchored to an element in this iframe.
  let anchorTarget: number | 'picked' | null = null
  let anchorChannel = ''
  let anchorFrame = 0
  let anchorTimer: ReturnType<typeof setTimeout> | null = null
  let anchorLastSentAt = 0
  let anchorLastKey: string | null = null
  let anchorInFlight = false
  let anchorDirty = false
  let anchorListening = false

  function rectBox(element: Element | null): PageBox | null {
    if (!element || !element.isConnected) return null
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  function resolveAnchorElement(target: number | 'picked' | null): Element | null {
    if (target === null) return null
    if (target === 'picked') return picked
    return sourceElement(target)
  }

  function pickedManyUnionBox(): PageBox | null {
    if (pickedMany.length === 0) return null
    const boxes: PageBox[] = []
    for (const el of pickedMany) {
      const box = rectBox(el)
      if (box) boxes.push(box)
    }
    return unionPageBoxes(boxes)
  }

  function anchorCenterElementForMany(): Element | null {
    const union = pickedManyUnionBox()
    if (!union) return pickedMany.find((el) => el.isConnected) ?? null
    const cx = union.x + union.width / 2
    const cy = union.y + union.height / 2
    let best: Element | null = null
    let bestDist = Infinity
    for (const el of pickedMany) {
      const box = rectBox(el)
      if (!box) continue
      const dx = box.x + box.width / 2 - cx
      const dy = box.y + box.height / 2 - cy
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        best = el
      }
    }
    return best
  }

  function snapHalf(n: number): number {
    return Math.round(n * 2) / 2
  }

  function anchorSnapshot(): { report: AnchorRectReport; key: string } {
    const box =
      anchorTarget === 'picked' && pickedMany.length > 0
        ? pickedManyUnionBox()
        : rectBox(resolveAnchorElement(anchorTarget))
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const key = box
      ? `${snapHalf(box.x)},${snapHalf(box.y)},${snapHalf(box.width)},${snapHalf(box.height)}|${viewport.width},${viewport.height}`
      : `null|${viewport.width},${viewport.height}`
    return { report: { box, viewport }, key }
  }

  function sendAnchorReport(force: boolean): void {
    if (anchorTarget === null || !anchorChannel) return
    const { report: anchor, key } = anchorSnapshot()
    if (!force && key === anchorLastKey) return
    if (config.transport === 'fetch' && anchorInFlight) {
      anchorDirty = true
      return
    }
    const now = Date.now()
    const wait = ANCHOR_SYNC_MIN_MS - (now - anchorLastSentAt)
    if (!force && wait > 0) {
      if (anchorTimer === null) {
        anchorTimer = setTimeout(() => {
          anchorTimer = null
          scheduleAnchorSync()
        }, wait)
      }
      return
    }
    anchorLastKey = key
    anchorLastSentAt = now
    const message: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'select',
      channel: anchorChannel,
      selection: null,
      anchor,
    }
    if (config.transport === 'port') {
      viaPort(message)
      return
    }
    anchorInFlight = true
    void request(message)
      .catch(() => {})
      .finally(() => {
        anchorInFlight = false
        if (anchorDirty && anchorTarget !== null) {
          anchorDirty = false
          scheduleAnchorSync()
        }
      })
  }

  function scheduleAnchorSync(): void {
    if (anchorTarget === null || anchorFrame) return
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = 0
      sendAnchorReport(false)
    })
  }

  const onAnchorViewportChange = (): void => scheduleAnchorSync()

  function setAnchorTracking(target: number | 'picked' | null, nextChannel?: string): void {
    if (target === null) {
      anchorTarget = null
      anchorLastKey = null
      anchorDirty = false
      if (anchorFrame) {
        cancelAnimationFrame(anchorFrame)
        anchorFrame = 0
      }
      if (anchorTimer !== null) {
        clearTimeout(anchorTimer)
        anchorTimer = null
      }
      if (anchorListening) {
        window.removeEventListener('scroll', onAnchorViewportChange, true)
        window.removeEventListener('resize', onAnchorViewportChange)
        anchorListening = false
      }
      return
    }
    anchorTarget = target
    if (nextChannel) anchorChannel = nextChannel
    else if (channel) anchorChannel = channel
    if (!anchorListening) {
      window.addEventListener('scroll', onAnchorViewportChange, { capture: true, passive: true })
      window.addEventListener('resize', onAnchorViewportChange, { passive: true })
      anchorListening = true
    }
    anchorLastKey = null
    sendAnchorReport(true)
  }

  function place(box: HTMLElement, element: Element | null): DOMRect | null {
    if (!element || !element.isConnected) {
      box.style.display = 'none'
      return null
    }
    const rect = element.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${rect.left - 2}px`
    box.style.top = `${rect.top - 2}px`
    box.style.width = `${rect.width + 4}px`
    box.style.height = `${rect.height + 4}px`
    return rect
  }

  function drawMulti(elements: readonly Element[], kind: 'hover' | 'picked'): void {
    const connected = elements.filter((el) => el.isConnected)
    while (multiLayer!.children.length > connected.length) multiLayer!.lastChild!.remove()
    connected.forEach((element, i) => {
      let box = multiLayer!.children[i] as HTMLElement | undefined
      if (!box) {
        box = document.createElement('div')
        multiLayer!.append(box)
      }
      box.className = `box ${kind}`
      place(box, element)
    })
  }

  function draw(): void {
    frame = 0
    const marqueeActive = mode === 'select' && marqueeRect !== null
    const multiActive = mode === 'select' && pickedMany.length > 0
    const showing =
      (mode !== null && (hovered !== null || picked !== null || multiActive || marqueeActive)) ||
      pins.length > 0
    if (!showing) {
      host?.remove()
      return
    }
    overlay()
    if (marqueeActive && marqueeRect) {
      marqueeBox!.style.display = 'block'
      marqueeBox!.style.left = `${marqueeRect.x}px`
      marqueeBox!.style.top = `${marqueeRect.y}px`
      marqueeBox!.style.width = `${marqueeRect.width}px`
      marqueeBox!.style.height = `${marqueeRect.height}px`
      drawMulti(marqueeHits, 'hover')
      place(hoverBox!, null)
      place(pickedBox!, null)
      label!.style.display = 'none'
    } else {
      marqueeBox!.style.display = 'none'
      if (multiActive) {
        drawMulti(pickedMany, 'picked')
        place(hoverBox!, hovered && !pickedMany.includes(hovered) ? hovered : null)
        place(pickedBox!, null)
        label!.style.display = 'none'
      } else {
        drawMulti([], 'picked')
        place(hoverBox!, mode && hovered !== picked ? hovered : null)
        const rect = place(pickedBox!, mode ? picked : null)
        if (rect && picked) {
          label!.style.display = 'block'
          label!.textContent = picked.localName
          label!.style.left = `${Math.max(0, rect.left - 2)}px`
          label!.style.top = `${Math.max(0, rect.top - 22)}px`
        } else {
          label!.style.display = 'none'
        }
      }
    }
    drawPins()
    if (anchorTarget !== null) sendAnchorReport(false)
    // Pages move as they scroll and animate, so the overlay follows them while it shows.
    frame = requestAnimationFrame(draw)
  }

  function redraw(): void {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  function drawPins(): void {
    const at = new Map<string, number>()
    const shown = pins.map((pin) => {
      const element = pin.src === null ? null : sourceElement(pin.src)
      const rect = element?.getBoundingClientRect() ?? null
      const x = rect ? Math.min(window.innerWidth - 22, Math.max(2, rect.right - 10)) : 8
      const y = rect ? Math.min(window.innerHeight - 22, Math.max(2, rect.top - 10)) : 8
      const key = `${Math.round(x)},${Math.round(y)}`
      const stacked = at.get(key) ?? 0
      at.set(key, stacked + 1)
      // Pins at an element stack leftwards from its corner; those on the page's own corner go
      // rightwards, so none leaves the page.
      return { pin, x: Math.max(2, rect ? x - stacked * 22 : x + stacked * 22), y }
    })
    pinBoxes = shown.map(({ pin, x, y }) => ({ n: pin.n, x, y }))
    while (pinLayer!.children.length > shown.length) pinLayer!.lastChild!.remove()
    shown.forEach(({ pin, x, y }, i) => {
      let el = pinLayer!.children[i] as HTMLElement | undefined
      if (!el) {
        el = document.createElement('div')
        pinLayer!.append(el)
      }
      const kind = pin.kind === 'lost' || pin.kind === 'done' ? ` ${pin.kind}` : ''
      el.className = `pin${pin.answered ? ' answered' : ''}${kind}${pin.active ? ' active' : ''}`
      el.textContent = pin.kind === 'done' ? '\u2713' : String(pin.n)
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    })
  }

  function sourceElement(src: number): Element | null {
    return document.querySelector(`[${SOURCE}="${config.mark}:${src}"]`)
  }

  function elementAt(x: number, y: number): Element | null {
    const element = document.elementFromPoint(x, y)
    return element && element !== host ? element : null
  }

  function hex(color: string): string | null {
    const match =
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color)
    if (!match) return null
    const byte = (value: number): string =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, '0')
    const alpha =
      match[4] === undefined
        ? 1
        : match[4].endsWith('%')
          ? parseFloat(match[4]) / 100
          : parseFloat(match[4])
    const rgb = `#${byte(+match[1]!)}${byte(+match[2]!)}${byte(+match[3]!)}`
    return alpha >= 1 ? rgb : `${rgb}${byte(alpha * 255)}`
  }

  function lookOf(element: Element): ElementStyle {
    const css = getComputedStyle(element)
    const size = (value: string): number | null => {
      const n = parseFloat(value)
      return Number.isFinite(n) ? n : null
    }
    const align =
      css.textAlign === 'start' ? 'left' : css.textAlign === 'end' ? 'right' : css.textAlign
    const padding = [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(size)
    return {
      color: hex(css.color),
      background: hex(css.backgroundColor),
      fontSize: size(css.fontSize),
      fontWeight: size(css.fontWeight),
      textAlign: ['left', 'center', 'right', 'justify'].includes(align)
        ? (align as ElementStyle['textAlign'])
        : null,
      padding: padding.every((p) => p !== null)
        ? (padding as [number, number, number, number])
        : null,
      radius: size(css.borderTopLeftRadius),
    }
  }

  function sourceOffset(element: Element): number | null {
    // An element from other markup the page put in, or one a script made, has no place here.
    const raw = element.getAttribute(SOURCE)
    const own = raw?.startsWith(`${config.mark}:`) ? raw.slice(config.mark.length + 1) : null
    return own !== null && /^\d{1,9}$/.test(own) ? Number(own) : null
  }

  function describe(element: Element): PageSelection {
    const src = sourceOffset(element)
    const text = (element as HTMLElement).innerText ?? element.textContent ?? ''
    const ancestors: string[] = []
    for (let up = element.parentElement; up && up !== document.body; up = up.parentElement) {
      if (up === document.documentElement) break
      ancestors.unshift(up.localName.toLowerCase())
    }
    const box = rectBox(element)
    return {
      path: config.path,
      src,
      tag: element.localName.toLowerCase(),
      text: text.trim().slice(0, TEXT_CHARS),
      textOnly: element.childElementCount === 0,
      style: lookOf(element),
      ancestors: ancestors.slice(-8),
      ...(box ? { box } : {}),
    }
  }

  function pinAt(x: number, y: number): number | null {
    const hit = pinBoxes.findLast(
      (pin) => x >= pin.x && x <= pin.x + 20 && y >= pin.y && y <= pin.y + 20,
    )
    return hit ? hit.n : null
  }

  function sendPin(pin: number): void {
    const entry = pins.find((p) => p.n === pin)
    const pinBox = entry && entry.src !== null ? rectBox(sourceElement(entry.src)) : null
    const answer: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'select',
      channel,
      selection: null,
      pin,
      ...(pinBox ? { pinBox } : {}),
    }
    if (config.transport === 'port') viaPort(answer)
    else void request(answer).catch(() => {})
  }

  function stopTyping(report: boolean): void {
    const now = typing
    if (!now) return
    typing = null
    now.element.removeAttribute('contenteditable')
    now.element.removeEventListener('input', onTyped)
    now.element.removeEventListener('keydown', onTypingKey)
    if (report) sendTyped(now.element.textContent ?? '', true)
  }

  function sendTyped(text: string, done: boolean): void {
    const message: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'select',
      channel,
      selection: null,
      typed: { text: text.slice(0, 10_000), done },
    }
    if (config.transport === 'port') viaPort(message)
    else void request(message).catch(() => {})
  }

  function onTyped(): void {
    if (typing) sendTyped(typing.element.textContent ?? '', false)
  }

  function onTypingKey(event: KeyboardEvent): void {
    if (!typing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      typing.element.textContent = typing.before
      sendTyped(typing.before, false)
      stopTyping(true)
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      stopTyping(true)
    }
  }

  function report(selection: PageSelection | null): void {
    const message: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'select',
      channel,
      selection,
    }
    if (config.transport === 'port') viaPort(message)
    else void request(message).catch(() => {})
  }

  function reportMany(selections: PageSelection[]): void {
    const message: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'select',
      channel,
      selection: null,
      selections,
    }
    if (config.transport === 'port') viaPort(message)
    else void request(message).catch(() => {})
  }

  function resetPreview(): void {
    if (!original) return
    const { element, style, text } = original
    original = null
    if (style === null) element.removeAttribute('style')
    else element.setAttribute('style', style)
    if (text !== null) element.textContent = text
  }

  function remember(element: Element): void {
    if (original?.element === element) return
    resetPreview()
    original = { element, style: element.getAttribute('style'), text: null }
  }

  function clearMarquee(): void {
    marqueeRect = null
    marqueeHits = []
  }

  function pick(element: Element | null, tell: boolean): void {
    if (picked !== element) resetPreview()
    clearMarquee()
    pickedMany = []
    picked = element
    if (tell) report(element ? describe(element) : null)
    if (anchorTarget === 'picked') scheduleAnchorSync()
    redraw()
  }

  function drive(message: DriveMessage, ports: readonly MessagePort[]): void {
    switch (message.kind) {
      case 'transport': {
        if (config.transport !== 'port' || !ports[0]) return
        // The client hands a new port whenever it drives the page again, such as from a new view
        // of the same frame, and closes the old one, so nothing still waiting there is answered.
        const previous = port
        port = ports[0]
        port.onmessage = (event) => {
          const answer = event.data as Answer | null
          if (answer && typeof answer.id === 'string') waiting.get(answer.id)?.(answer)
        }
        if (previous) {
          previous.onmessage = null
          previous.close()
          for (const [id, settle] of [...waiting]) {
            settle({ id, ok: false, error: { code: 'failed', message: 'The client reconnected' } })
          }
        }
        for (const waitingMessage of queued.splice(0)) port.postMessage(waitingMessage)
        return
      }
      case 'select-mode':
        mode = message.mode === 'select' || message.mode === 'comment' ? message.mode : null
        channel = typeof message.channel === 'string' ? message.channel : ''
        if (typeof message.accent === 'string' && CSS.supports('color', message.accent)) {
          accent = message.accent
          host?.style.setProperty('--accent', accent)
        }
        if (message.pinColors && typeof message.pinColors === 'object') {
          const sent: { readonly [key: string]: unknown } = { ...message.pinColors }
          const next = { ...pinColors }
          for (const [key, name] of [
            ['ink', '--pin'],
            ['text', '--pin-text'],
            ['ground', '--pin-ground'],
            ['done', '--pin-done'],
          ] as const) {
            const value = sent[key]
            if (typeof value === 'string' && CSS.supports('color', value)) next[name] = value
          }
          pinColors = next
          for (const [name, value] of Object.entries(pinColors))
            host?.style.setProperty(name, value)
        }
        if (!mode) {
          hovered = null
          stopTyping(true)
          pick(null, false)
        } else if (mode !== 'select') {
          clearMarquee()
          pickedMany = []
        }
        redraw()
        return
      case 'select-point':
        if (!mode) return
        hovered = elementAt(message.x, message.y)
        redraw()
        return
      case 'select-leave':
        hovered = null
        redraw()
        return
      case 'select-pick': {
        if (!mode) return
        const pin = pinAt(message.x, message.y)
        if (pin !== null) {
          sendPin(pin)
          return
        }
        const element = elementAt(message.x, message.y)
        if (mode === 'comment' && element) {
          const openPin = openPinForSource(pins, sourceOffset(element))
          if (openPin !== null) {
            sendPin(openPin)
            return
          }
        }
        if (typing && typing.element.contains(element)) return
        stopTyping(true)
        pick(element, true)
        return
      }
      case 'select-marquee': {
        if (mode !== 'select') return
        const raw = message.rect
        if (raw === null) {
          clearMarquee()
          redraw()
          return
        }
        if (
          !raw ||
          typeof raw !== 'object' ||
          !Number.isFinite(raw.x) ||
          !Number.isFinite(raw.y) ||
          !Number.isFinite(raw.width) ||
          !Number.isFinite(raw.height)
        ) {
          return
        }
        const rect: PageBox = {
          x: raw.width < 0 ? raw.x + raw.width : raw.x,
          y: raw.height < 0 ? raw.y + raw.height : raw.y,
          width: Math.abs(raw.width),
          height: Math.abs(raw.height),
        }
        const hits = findMarqueeElements(
          document,
          rect,
          { width: window.innerWidth, height: window.innerHeight },
          typeof getComputedStyle === 'function' ? getComputedStyle : null,
          host,
        )
        if (message.commit !== true) {
          hovered = null
          marqueeRect = rect
          marqueeHits = hits
          redraw()
          return
        }
        stopTyping(true)
        resetPreview()
        clearMarquee()
        hovered = null
        picked = null
        pickedMany = hits
        if (hits.length > 0) reportMany(hits.map(describe))
        else report(null)
        if (anchorTarget === 'picked') scheduleAnchorSync()
        redraw()
        return
      }
      case 'select-remove': {
        if (mode !== 'select' || !Number.isInteger(message.index)) return
        if (message.index < 0 || message.index >= pickedMany.length) return
        pickedMany.splice(message.index, 1)
        redraw()
        if (anchorTarget === 'picked') sendAnchorReport(true)
        return
      }
      case 'select-reveal': {
        const replyChannel =
          typeof message.channel === 'string' && message.channel !== '' ? message.channel : null
        if (replyChannel) channel = replyChannel
        if (!Number.isSafeInteger(message.src)) return
        const element = sourceElement(message.src)
        if (element) {
          const before = element.getBoundingClientRect()
          const inView =
            before.bottom > 0 &&
            before.top < window.innerHeight &&
            before.right > 0 &&
            before.left < window.innerWidth
          if (!inView) {
            element.scrollIntoView({
              block: 'center',
              behavior: replyChannel ? 'instant' : 'smooth',
            })
            redraw()
          }
        }
        if (replyChannel) {
          const box = rectBox(element)
          const answer: Message = {
            v: RUNTIME_VERSION,
            id: nextId(),
            kind: 'select',
            channel: replyChannel,
            selection: null,
            located: { src: message.src, box },
          }
          if (config.transport === 'port') viaPort(answer)
          else void request(answer).catch(() => {})
        }
        if (anchorTarget !== null) scheduleAnchorSync()
        return
      }
      case 'select-anchor': {
        const replyChannel =
          typeof message.channel === 'string' && message.channel !== '' ? message.channel : channel
        if (
          message.target === null ||
          message.target === 'picked' ||
          (typeof message.target === 'number' && Number.isSafeInteger(message.target))
        ) {
          setAnchorTracking(message.target, replyChannel)
        }
        return
      }
      case 'select-scroll-anchor': {
        const target =
          message.target === 'picked' ||
          (typeof message.target === 'number' && Number.isSafeInteger(message.target))
            ? message.target
            : anchorTarget
        const element =
          target === 'picked' && pickedMany.length > 0
            ? anchorCenterElementForMany()
            : resolveAnchorElement(target)
        if (element && element.isConnected) {
          element.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' })
          redraw()
          scheduleAnchorSync()
        }
        return
      }
      case 'select-scroll':
        if (Number.isFinite(message.dx) && Number.isFinite(message.dy)) {
          window.scrollBy({ left: message.dx, top: message.dy, behavior: 'instant' })
          redraw()
          scheduleAnchorSync()
        }
        return
      case 'select-up': {
        if (!mode || !picked) return
        let up: Element | null = picked
        for (let i = 0; i < Math.max(1, Math.min(8, Number(message.levels) || 1)); i++) {
          const next: Element | null = up?.parentElement ?? null
          if (!next || next === document.body || next === document.documentElement) break
          up = next
        }
        stopTyping(true)
        if (up && up !== picked) pick(up, true)
        return
      }
      case 'text-edit': {
        if (message.on !== true) {
          stopTyping(true)
          return
        }
        if (mode !== 'select' || !picked || picked.childElementCount > 0 || typing) return
        const element = picked as HTMLElement
        remember(element)
        original!.text ??= element.textContent
        typing = { element, before: element.textContent ?? '' }
        element.setAttribute('contenteditable', 'plaintext-only')
        element.addEventListener('input', onTyped)
        element.addEventListener('keydown', onTypingKey)
        element.focus()
        const range = document.createRange()
        range.selectNodeContents(element)
        range.collapse(false)
        const chosen = window.getSelection()
        chosen?.removeAllRanges()
        chosen?.addRange(range)
        return
      }
      case 'select-source':
        pick(
          message.src === null ? null : sourceElement(message.src),
          message.src !== null && message.tell === true,
        )
        return
      case 'select-pins':
        pins = Array.isArray(message.pins) ? message.pins.slice(0, 200) : []
        redraw()
        return
      case 'preview-style': {
        if (!picked || typeof message.style !== 'object' || message.style === null) return
        remember(picked)
        const element = picked as HTMLElement
        element.setAttribute('style', original!.style ?? '')
        for (const [property, value] of Object.entries(message.style)) {
          if (typeof value === 'string') element.style.setProperty(property, value)
        }
        scheduleAnchorSync()
        return
      }
      case 'preview-text':
        if (!picked || typeof message.text !== 'string' || picked.childElementCount > 0) return
        // What is typed in place shows already, and setting it would move the caret.
        if (typing?.element === picked) return
        remember(picked)
        original!.text ??= picked.textContent
        picked.textContent = message.text
        scheduleAnchorSync()
        return
      case 'preview-reset':
        resetPreview()
        scheduleAnchorSync()
        return
      case 'select-locate': {
        if (typeof message.channel === 'string' && message.channel !== '') channel = message.channel
        if (!Number.isSafeInteger(message.src)) return
        const element = sourceElement(message.src)
        const rect = element?.getBoundingClientRect()
        const located = {
          src: message.src,
          box: rect
            ? {
                x: rect.left + scrollX,
                y: rect.top + scrollY,
                width: rect.width,
                height: rect.height,
              }
            : null,
        }
        const answer: Message = {
          v: RUNTIME_VERSION,
          id: nextId(),
          kind: 'select',
          channel,
          selection: null,
          located,
        }
        if (config.transport === 'port') viaPort(answer)
        else void request(answer).catch(() => {})
        return
      }
      case 'params':
        if (typeof message.values !== 'object' || message.values === null) return
        for (const [name, value] of Object.entries(message.values)) setParam(name, value)
        scheduleAnchorSync()
        return
      case 'keep-scroll':
        keepScroll = true
        return
      case 'select-keys':
        if (typeof message.channel === 'string' && message.channel !== '') channel = message.channel
        passKeys = message.on === true
        return
      case 'select-doc':
      case 'select-deck':
        // The document and slides viewers read the state themselves; their reports go out on
        // this channel.
        if (typeof message.channel === 'string' && message.channel !== '') channel = message.channel
        return
    }
  }

  // What a document or slides viewer reports of itself, once the client drives it in the viewer;
  // the client checks it like any pick.
  const passReport = (field: 'doc' | 'deck') => (event: Event) => {
    if (!channel || !(event instanceof CustomEvent)) return
    const message: Message = {
      v: RUNTIME_VERSION,
      id: nextId(),
      kind: 'select',
      channel,
      selection: null,
      [field]: event.detail as unknown,
    }
    if (config.transport === 'port') viaPort(message)
    else void request(message).catch(() => {})
  }
  window.addEventListener(DOC_REPORT_EVENT, passReport('doc'))
  window.addEventListener(DECK_REPORT_EVENT, passReport('deck'))

  // Keys the viewer steps with, once the user clicked into the page; typing in a field keeps them.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!passKeys || !channel || event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      if (!(PAGE_KEYS as readonly string[]).includes(key)) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest?.(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        return
      }
      const message: Message = {
        v: RUNTIME_VERSION,
        id: nextId(),
        kind: 'select',
        channel,
        selection: null,
        key,
      }
      if (config.transport === 'port') viaPort(message)
      else void request(message).catch(() => {})
    },
    true,
  )

  // The parameters the page declares, on its root from the start, as the canvas set them last.
  const params = new Map<string, PageParam>()
  function setParam(name: string, value: unknown): void {
    const param = params.get(name)
    if (!param || !validParamValue(param, value)) return
    const { variable, attribute } = paramCss(param, value as string | number | boolean)
    const root = document.documentElement
    root.style.setProperty(`--${name}`, variable)
    root.setAttribute(`data-${name}`, attribute)
  }
  function readParams(): void {
    const script = document.querySelector(`script[${PARAMS_ATTRIBUTE}]`)
    if (!script) return
    for (const param of parseParams(script.textContent ?? '')) {
      params.set(param.name, param)
      setParam(param.name, param.value)
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', readParams)
  else readParams()

  // A page told that its next version replaces it, as an edit saves one, hands its scroll to that
  // version through the session's storage of the artifact's origin, read once and only shortly
  // after. A frame on an opaque origin, as the web client's are, has no storage and starts at top.
  const KEPT = 'kettu-scroll'
  const file = location.pathname.replace(/\/v\/\d+\//, '/')
  const scrollTo = window.scrollTo.bind(window)
  const storage = (() => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  })()
  try {
    const kept = storage?.getItem(KEPT)
    if (kept) {
      storage!.removeItem(KEPT)
      const { path, x, y, at } = JSON.parse(kept) as Record<string, unknown>
      if (path === file && typeof at === 'number' && Date.now() - at < SCROLL_KEPT_MS) {
        let placed = -1
        const place = (): void => {
          scrollTo({ left: Number(x) || 0, top: Number(y) || 0, behavior: 'instant' })
          placed = window.scrollY
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', place, { once: true })
        } else place()
        // Images and fonts may make the page long enough only once they load.
        window.addEventListener('load', () => window.scrollY === placed && place(), { once: true })
      }
    }
  } catch {
    // A page may have written the key itself; it starts at the top then.
  }
  window.addEventListener('pagehide', () => {
    if (!keepScroll) return
    const at = Date.now()
    try {
      storage?.setItem(KEPT, JSON.stringify({ path: file, x: scrollX, y: scrollY, at }))
    } catch {
      // Storage full or turned off: the next version starts at the top.
    }
  })

  window.addEventListener('message', (event) => {
    // Only the client that holds the frame drives it; the page's own messages are ignored.
    if (event.source !== parent || parent === window) return
    const data = event.data as DriveMessage | null
    if (!data || typeof data !== 'object' || data.v !== RUNTIME_VERSION) return
    if (typeof data.kind !== 'string') return
    if (
      data.kind !== 'transport' &&
      data.kind !== 'params' &&
      data.kind !== 'keep-scroll' &&
      data.kind !== 'text-edit' &&
      !data.kind.startsWith('select') &&
      !data.kind.startsWith('preview')
    ) {
      return
    }
    try {
      drive(data, event.ports)
    } catch {
      // A page that broke the DOM methods the runtime uses shows no outline; it still runs.
    }
  })
}
