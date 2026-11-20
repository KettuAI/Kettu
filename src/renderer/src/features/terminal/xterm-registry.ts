import type { ITheme, Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { TERMINAL_FLOW } from '@shared/terminal-host'
import { emitAppEvent } from '@renderer/app/events'
import { terminals } from '@renderer/lib/host'
import { isMac, isMod } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import { holdsTerminalInput, setSink, useTerminalsStore } from '@renderer/stores/terminals'
import { terminalFontStack } from './font-stack'
import { passesHeld } from './held-keys'
import { onColorsChange } from '@renderer/stores/themes'

// One xterm.js instance per terminal for the terminal's whole life. A tab that is hidden, or a
// project that is not shown, keeps its instance; only its element leaves the page, so switching
// back costs no replay and the scrollback stays intact. Only a shown terminal holds a WebGL
// context, since the page may keep few of them alive.

type Modules = {
  Terminal: typeof import('@xterm/xterm').Terminal
  FitAddon: typeof import('@xterm/addon-fit').FitAddon
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon
}

let modules: Promise<Modules> | null = null

function loadModules(): Promise<Modules> {
  modules ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-webgl'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
    loadFont(),
  ]).then(([xterm, fit, webgl, links]) => ({
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    WebglAddon: webgl.WebglAddon,
    WebLinksAddon: links.WebLinksAddon,
  }))
  return modules
}

export interface Instance {
  id: string
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  visible: boolean
  size: { cols: number; rows: number }
  /** The WebGL renderer while the terminal shows, and the canvas its context is on. */
  webgl: { addon: { dispose(): void }; canvas: HTMLCanvasElement | null } | null
}

const instances = new Map<string, Promise<Instance>>()
const ready = new Map<string, Instance>()

let colorContext: CanvasRenderingContext2D | null | undefined

/** xterm.js reads only hex and comma rgb(), so the canvas rewrites any color, keeping alpha. */
function xtermColor(value: string): string {
  if (!value || !CSS.supports('color', value)) return value
  colorContext ??= document.createElement('canvas').getContext('2d')
  if (!colorContext) return value
  colorContext.fillStyle = value
  return colorContext.fillStyle
}

function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--terminal-background'),
    foreground: v('--terminal-foreground'),
    cursor: v('--terminal-cursor'),
    cursorAccent: v('--terminal-background'),
    selectionBackground: xtermColor(v('--terminal-selection')),
    black: v('--ansi-black'),
    red: v('--ansi-red'),
    green: v('--ansi-green'),
    yellow: v('--ansi-yellow'),
    blue: v('--ansi-blue'),
    magenta: v('--ansi-magenta'),
    cyan: v('--ansi-cyan'),
    white: v('--ansi-white'),
    brightBlack: v('--ansi-bright-black'),
    brightRed: v('--ansi-bright-red'),
    brightGreen: v('--ansi-bright-green'),
    brightYellow: v('--ansi-bright-yellow'),
    brightBlue: v('--ansi-bright-blue'),
    brightMagenta: v('--ansi-bright-magenta'),
    brightCyan: v('--ansi-bright-cyan'),
    brightWhite: v('--ansi-bright-white'),
  }
}

function fontFamily(): string {
  const theme =
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
  return terminalFontStack(useSettingsStore.getState().settings.terminal.fontFamily, theme)
}

/** xterm.js measures its cells as a terminal opens, so the face must be loaded by then. */
async function loadFont(): Promise<void> {
  const size = useSettingsStore.getState().settings.terminal.fontSize
  try {
    await document.fonts.load(`${size}px ${fontFamily()}`)
  } catch (error) {
    console.warn('Terminal font unavailable; using a fallback', error)
  }
}

let watching = false

/** A face must load before xterm.js measures it, so the instances follow once it has. */
function syncFontFamily(): void {
  void loadFont().then(() => {
    const family = fontFamily()
    for (const instance of ready.values()) {
      if (instance.term.options.fontFamily === family) continue
      instance.term.options.fontFamily = family
      if (instance.visible) fitNow(instance)
    }
  })
}

/** Follows the colors, the font and removed terminals for every instance. */
function watchOnce(): void {
  if (watching) return
  watching = true
  onColorsChange(() => {
    const theme = readTheme()
    for (const instance of ready.values()) instance.term.options.theme = theme
    // A theme may name another face for code.
    syncFontFamily()
  })
  useSettingsStore.subscribe((state, previous) => {
    const size = state.settings.terminal.fontSize
    if (size !== previous.settings.terminal.fontSize) {
      for (const instance of ready.values()) {
        instance.term.options.fontSize = size
        if (instance.visible) fitNow(instance)
      }
    }
    if (
      state.settings.terminal.fontFamily !== previous.settings.terminal.fontFamily ||
      state.settings.appearance.fonts.code !== previous.settings.appearance.fonts.code
    ) {
      syncFontFamily()
    }
  })
  useTerminalsStore.subscribe((state, previous) => {
    for (const id of Object.keys(previous.byId)) if (!(id in state.byId)) dispose(id)
  })
}

export function getInstance(id: string): Promise<Instance> {
  const existing = instances.get(id)
  if (existing) return existing
  const created = create(id)
  instances.set(id, created)
  return created
}

async function create(id: string): Promise<Instance> {
  const m = await loadModules()
  watchOnce()
  const term = new m.Terminal({
    allowProposedApi: true,
    scrollback: TERMINAL_FLOW.scrollback,
    fontFamily: fontFamily(),
    fontSize: useSettingsStore.getState().settings.terminal.fontSize,
    lineHeight: 1.2,
    cursorStyle: 'bar',
    cursorBlink: true,
    cursorInactiveStyle: 'bar',
    macOptionIsMeta: false,
    theme: readTheme(),
    rightClickSelectsWord: false,
  })
  const fit = new m.FitAddon()
  term.loadAddon(fit)
  term.loadAddon(
    new m.WebLinksAddon((event, uri) => {
      if (isMod(event) && /^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener')
    }),
  )
  const element = document.createElement('div')
  element.className = 'size-full'
  element.dataset.terminal = id
  const instance: Instance = {
    id,
    term,
    fit,
    element,
    visible: false,
    size: { cols: 0, rows: 0 },
    webgl: null,
  }

  term.attachCustomKeyEventHandler((event) => keyHandler(instance, event))
  // Input, acks and resizes fail only for a terminal that has ended, which its tab already shows.
  term.onData((data) => void terminals('terminals.input', { id, data }).catch(() => undefined))
  // While an agent's turn uses the terminal, keys are held back in keyHandler. onData also carries
  // xterm.js's answers to the program, such as focus and cursor reports, so IME text and pastes are
  // held back as they start instead; xterm.js stops a paste event's propagation, hence the capture.
  element.addEventListener(
    'paste',
    (event) => {
      if (!holdsTerminalInput(id)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      held(instance)
    },
    true,
  )
  element.addEventListener(
    'compositionstart',
    (event) => {
      if (!holdsTerminalInput(id)) return
      // Leaving the field ends the composition before any of its text is sent.
      ;(event.target as HTMLElement | null)?.blur()
      held(instance)
      requestAnimationFrame(() => term.focus())
    },
    true,
  )

  // Output written before the replay arrives would be duplicated by it, so it waits.
  let unacked = 0
  let replayed = false
  const early: string[] = []
  const write = (data: string) => {
    term.write(data, () => {
      unacked += data.length
      if (unacked >= TERMINAL_FLOW.ackChars) {
        const chars = unacked
        unacked = 0
        void terminals('terminals.ack', { id, chars }).catch(() => undefined)
      }
    })
    if (!instance.visible) markActivity(id)
  }
  setSink(
    id,
    (data) => {
      if (replayed) write(data)
      else early.push(data)
    },
    // Another host's terminal, attached again or caught up after falling behind.
    (replay) => {
      term.reset()
      term.write(replay)
    },
  )
  try {
    const { replay } = await terminals('terminals.attach', { id })
    if (replay) term.write(replay)
  } catch {
    // A terminal the host no longer knows: the tab shows it as stopped.
  }
  replayed = true
  for (const data of early.splice(0)) write(data)

  ready.set(id, instance)
  return instance
}

function markActivity(id: string): void {
  const t = useTerminalsStore.getState().byId[id]
  if (!t || t.activity) return
  useTerminalsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...t, activity: true } } }))
}

/**
 * Opens the instance in a container the first time, and moves it there afterwards; with `webgl`,
 * it draws with a WebGL context while it shows.
 */
export function mount(instance: Instance, container: HTMLElement, webgl: boolean): void {
  container.appendChild(instance.element)
  if (!instance.term.element) instance.term.open(instance.element)
  instance.visible = true
  if (webgl && !instance.webgl) void loadWebgl(instance)
  fitNow(instance)
}

/** Takes the instance off the page, giving its WebGL context back; the buffer stays. */
export function unmount(instance: Instance): void {
  instance.visible = false
  releaseWebgl(instance)
  instance.element.remove()
}

async function loadWebgl(instance: Instance): Promise<void> {
  const m = await loadModules()
  // Hidden again, or another call loaded it, while the modules loaded.
  if (!instance.visible || instance.webgl) return
  const screen = instance.term.element
  const before = new Set(screen?.querySelectorAll('canvas'))
  try {
    const addon = new m.WebglAddon()
    // On a lost context, xterm.js falls back to its DOM renderer and keeps the buffer; the next
    // time the terminal shows, it tries WebGL again.
    addon.onContextLoss(() => {
      addon.dispose()
      if (instance.webgl?.addon === addon) instance.webgl = null
    })
    instance.term.loadAddon(addon)
    // The renderer's own canvas, beside the 2D one it adds for links; both have their context
    // by now, so asking for WebGL here creates none.
    const canvas = [...(screen?.querySelectorAll('canvas') ?? [])].find(
      (c) => !before.has(c) && c.getContext('webgl2') !== null,
    )
    instance.webgl = { addon, canvas: canvas ?? null }
  } catch (error) {
    console.warn('WebGL renderer unavailable; using the DOM renderer', error)
  }
}

function releaseWebgl(instance: Instance): void {
  const webgl = instance.webgl
  if (!webgl) return
  instance.webgl = null
  webgl.addon.dispose()
  // A disposed renderer leaves its context to the garbage collector, which the page's limit on
  // live contexts still counts until then.
  webgl.canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
}

/**
 * The side panel glides its pane open and closed, and a terminal that fits on the way would tell
 * its shell a width of a few columns. It fits once the glide ends.
 */
function isGliding(instance: Instance): boolean {
  return instance.element.closest('.kettu-pane-area[data-glide]') !== null
}

export function fitNow(instance: Instance): void {
  if (!instance.visible || !instance.element.isConnected || isGliding(instance)) return
  const dims = instance.fit.proposeDimensions()
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
  const cols = Math.max(2, Math.min(1000, dims.cols))
  const rows = Math.max(1, Math.min(1000, dims.rows))
  if (cols === instance.size.cols && rows === instance.size.rows) return
  instance.size = { cols, rows }
  instance.term.resize(cols, rows)
  void terminals('terminals.resize', { id: instance.id, cols, rows }).catch(() => undefined)
}

function dispose(id: string): void {
  const pending = instances.get(id)
  instances.delete(id)
  ready.delete(id)
  setSink(id, null)
  void pending?.then((instance) => {
    releaseWebgl(instance)
    instance.element.remove()
    instance.term.dispose()
  })
}

export async function copySelection(instance: Instance): Promise<void> {
  const text = instance.term.getSelection()
  if (text) await navigator.clipboard.writeText(text)
}

export async function pasteClipboard(instance: Instance): Promise<void> {
  if (holdsTerminalInput(instance.id)) return held(instance)
  const text = await navigator.clipboard.readText()
  if (!text) return
  instance.term.paste(text)
}

/** Typing an agent's turn held back, at the terminal's cursor in the window's coordinates. */
export type HeldListener = (at: { x: number; y: number }) => void
const heldListeners = new Map<string, HeldListener>()

/** Hears the typing held back in a terminal, for the bubble at its cursor; returns the unsubscribe. */
export function onHeld(id: string, listener: HeldListener): () => void {
  heldListeners.set(id, listener)
  return () => {
    if (heldListeners.get(id) === listener) heldListeners.delete(id)
  }
}

function held(instance: Instance): void {
  const { term, element } = instance
  const box = element.getBoundingClientRect()
  const cell = {
    width: box.width / Math.max(1, term.cols),
    height: box.height / Math.max(1, term.rows),
  }
  const cursor = term.buffer.active
  heldListeners.get(instance.id)?.({
    x: box.left + (cursor.cursorX + 0.5) * cell.width,
    y: box.top + cursor.cursorY * cell.height,
  })
}

/** The selection as a fenced block for the composer. */
export function askAboutSelection(instance: Instance): boolean {
  const text = instance.term.getSelection().replace(/\s+$/, '')
  if (!text) return false
  const fence = text.includes('```') ? '````' : '```'
  emitAppEvent({
    kind: 'insert-into-composer',
    sessionId: null,
    text: `${fence}\n${text}\n${fence}\n`,
  })
  instance.term.clearSelection()
  return true
}

// Keys the app keeps while the terminal has focus: Ctrl+` and Ctrl+Shift+` everywhere, the
// clipboard keys of the platform, and Mod+L while text is selected.
function keyHandler(instance: Instance, event: KeyboardEvent): boolean {
  if (holdsTerminalInput(instance.id) && !passesHeld(event, isMac)) {
    if (event.type === 'keydown' && !event.repeat) held(instance)
    return false
  }
  if (event.type !== 'keydown') return true
  if (event.ctrlKey && !event.metaKey && event.code === 'Backquote') return false
  if (
    event.key.toLowerCase() === 'l' &&
    isMod(event) &&
    !event.shiftKey &&
    instance.term.hasSelection()
  ) {
    event.preventDefault()
    askAboutSelection(instance)
    return false
  }
  if (isMac) return !event.metaKey
  if (event.ctrlKey && event.shiftKey && !event.altKey) {
    if (event.code === 'KeyC') {
      event.preventDefault()
      void copySelection(instance)
      return false
    }
    if (event.code === 'KeyV') {
      event.preventDefault()
      void pasteClipboard(instance).catch((error: unknown) => console.warn('Paste failed', error))
      return false
    }
  }
  return true
}
