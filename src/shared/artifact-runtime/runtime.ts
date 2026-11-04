// The page runtime: the script Kettu runs first in every HTML file it serves from an artifact. It
// gives the page `kettu.use`, and for the editor outlines and reports the element the client
// points at and previews a style or text on it. The page only ever receives the client's messages;
// what it sends goes through one transport, which the server chose: a POST to its own origin on the
// desktop, or the port the web client hands it. Bundled on its own, it reaches nothing of Kettu's.

import { capabilityNamespace, type RuntimeTransport } from './capabilities'
import {
  RUNTIME_PATH,
  RUNTIME_VERSION,
  type DriveMessage,
  type ElementStyle,
  type PageSelection,
  type Pin,
  type RuntimeAnswer,
  type RuntimeConfig,
} from './page-messages'

const USE_WAIT_MS = 10_000
const SOURCE = 'data-kettu-src'
const TEXT_CHARS = 200

type Message = Record<string, unknown> & { v: typeof RUNTIME_VERSION; id: string; kind: string }
type Answer = Partial<RuntimeAnswer> & { id?: unknown; event?: unknown; done?: unknown }

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
      })
      .catch(() => end({ ok: false, error: { code: 'failed', message: 'The stream ended' } }))
    return () => {
      ended = true
      abort.abort()
    }
  }

  function failure(answer: Answer): Error {
    const error = (answer as { error?: { code?: unknown; message?: unknown } }).error
    const failed = new Error(typeof error?.message === 'string' ? error.message : 'Failed')
    ;(failed as Error & { code?: string }).code =
      typeof error?.code === 'string' ? error.code : 'failed'
    return failed
  }

  const transport: RuntimeTransport = {
    call: (cap, op, args) =>
      request({ v: RUNTIME_VERSION, id: nextId(), kind: 'call', cap, op, args }).then((answer) => {
        if (answer.ok === true) return answer.value
        throw failure(answer)
      }),
    stream: (cap, op, args, onEvent) =>
      streamed({ v: RUNTIME_VERSION, id: nextId(), kind: 'stream', cap, op, args }, (answer) => {
        if ('event' in answer) onEvent(answer.event)
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
          return namespace ? freeze(namespace) : null
        } catch {
          return null
        }
      },
      () => null,
    )
    const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), USE_WAIT_MS))
    return Promise.race([answer, late])
  }

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
        '.label{position:fixed;display:none;padding:1px 6px;border-radius:4px;' +
        'background:var(--accent);color:white;font:500 11px/16px system-ui,sans-serif;white-space:nowrap}' +
        '.pin{position:fixed;width:20px;height:20px;border-radius:10px 10px 10px 2px;' +
        'background:var(--accent);color:white;font:600 11px/20px system-ui,sans-serif;' +
        'text-align:center;box-shadow:0 1px 3px rgb(0 0 0 / 30%)}' +
        '.pin.answered{background:#6b7280}'
      hoverBox = document.createElement('div')
      hoverBox.className = 'box hover'
      pickedBox = document.createElement('div')
      pickedBox.className = 'box picked'
      label = document.createElement('div')
      label.className = 'label'
      pinLayer = document.createElement('div')
      layer.append(style, pinLayer, hoverBox, pickedBox, label)
    }
    host.style.setProperty('--accent', accent)
    document.documentElement.append(host)
  }

  // Select mode and what it shows.

  let mode: 'select' | 'comment' | null = null
  let channel = ''
  let accent = '#f2581b'
  let hovered: Element | null = null
  let picked: Element | null = null
  let pins: Pin[] = []
  let frame = 0
  // What a preview changed on the picked element, to put back.
  let original: { element: Element; style: string | null; text: string | null } | null = null

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

  function draw(): void {
    frame = 0
    const showing = (mode !== null && (hovered !== null || picked !== null)) || pins.length > 0
    if (!showing) {
      host?.remove()
      return
    }
    overlay()
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
    drawPins()
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
      return { pin, x: x - stacked * 22, y }
    })
    while (pinLayer!.children.length > shown.length) pinLayer!.lastChild!.remove()
    shown.forEach(({ pin, x, y }, i) => {
      let el = pinLayer!.children[i] as HTMLElement | undefined
      if (!el) {
        el = document.createElement('div')
        pinLayer!.append(el)
      }
      el.className = pin.answered ? 'pin answered' : 'pin'
      el.textContent = String(pin.n)
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

  function describe(element: Element): PageSelection {
    // An element from other markup the page put in, or one a script made, has no place here.
    const raw = element.getAttribute(SOURCE)
    const own = raw?.startsWith(`${config.mark}:`) ? raw.slice(config.mark.length + 1) : null
    const src = own !== null && /^\d{1,9}$/.test(own) ? Number(own) : null
    const text = (element as HTMLElement).innerText ?? element.textContent ?? ''
    return {
      path: config.path,
      src,
      tag: element.localName.toLowerCase(),
      text: text.trim().slice(0, TEXT_CHARS),
      textOnly: element.childElementCount === 0,
      style: lookOf(element),
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

  function pick(element: Element | null, tell: boolean): void {
    if (picked !== element) resetPreview()
    picked = element
    if (tell) report(element ? describe(element) : null)
    redraw()
  }

  function drive(message: DriveMessage, ports: readonly MessagePort[]): void {
    switch (message.kind) {
      case 'transport':
        if (config.transport !== 'port' || port || !ports[0]) return
        port = ports[0]
        port.onmessage = (event) => {
          const answer = event.data as Answer | null
          if (answer && typeof answer.id === 'string') waiting.get(answer.id)?.(answer)
        }
        for (const waitingMessage of queued.splice(0)) port.postMessage(waitingMessage)
        return
      case 'select-mode':
        mode = message.mode === 'select' || message.mode === 'comment' ? message.mode : null
        channel = typeof message.channel === 'string' ? message.channel : ''
        if (typeof message.accent === 'string' && CSS.supports('color', message.accent)) {
          accent = message.accent
          host?.style.setProperty('--accent', accent)
        }
        if (!mode) {
          hovered = null
          pick(null, false)
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
      case 'select-pick':
        if (!mode) return
        pick(elementAt(message.x, message.y), true)
        return
      case 'select-source':
        pick(message.src === null ? null : sourceElement(message.src), false)
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
        return
      }
      case 'preview-text':
        if (!picked || typeof message.text !== 'string' || picked.childElementCount > 0) return
        remember(picked)
        original!.text ??= picked.textContent
        picked.textContent = message.text
        return
      case 'preview-reset':
        resetPreview()
        return
    }
  }

  window.addEventListener('message', (event) => {
    // Only the client that holds the frame drives it; the page's own messages are ignored.
    if (event.source !== parent || parent === window) return
    const data = event.data as DriveMessage | null
    if (!data || typeof data !== 'object' || data.v !== RUNTIME_VERSION) return
    if (typeof data.kind !== 'string') return
    if (
      data.kind !== 'transport' &&
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
