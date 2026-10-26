import type { ITheme, Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { TERMINAL_FLOW } from '@shared/terminal-host'
import { emitAppEvent } from '@renderer/app/events'
import { terminals } from '@renderer/lib/host'
import { isMac, isMod } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import { setSink, useTerminalsStore } from '@renderer/stores/terminals'
import { onColorsChange } from '@renderer/stores/themes'

// One xterm.js instance per terminal for the terminal's whole life. A tab that is hidden, or a
// project that is not shown, keeps its instance; only its element leaves the page, so switching
// back costs no replay and the scrollback stays intact.

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
}

const instances = new Map<string, Promise<Instance>>()
const ready = new Map<string, Instance>()

function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--terminal-background'),
    foreground: v('--terminal-foreground'),
    cursor: v('--terminal-cursor'),
    cursorAccent: v('--terminal-background'),
    selectionBackground: v('--terminal-selection'),
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
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
  )
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

/** Follows the colors, the font size and removed terminals for every instance. */
function watchOnce(): void {
  if (watching) return
  watching = true
  onColorsChange(() => {
    const theme = readTheme()
    for (const instance of ready.values()) instance.term.options.theme = theme
  })
  useSettingsStore.subscribe((state, previous) => {
    const size = state.settings.terminal.fontSize
    if (size === previous.settings.terminal.fontSize) return
    for (const instance of ready.values()) {
      instance.term.options.fontSize = size
      if (instance.visible) fitNow(instance)
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
  const instance: Instance = { id, term, fit, element, visible: false, size: { cols: 0, rows: 0 } }

  term.attachCustomKeyEventHandler((event) => keyHandler(instance, event))
  // Input, acks and resizes fail only for a terminal that has ended, which its tab already shows.
  term.onData((data) => void terminals('terminals.input', { id, data }).catch(() => undefined))

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
  setSink(id, (data) => {
    if (replayed) write(data)
    else early.push(data)
  })
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

/** Opens the instance in a container the first time, and moves it there afterwards. */
export function mount(instance: Instance, container: HTMLElement, webgl: boolean): void {
  container.appendChild(instance.element)
  if (!instance.term.element) {
    instance.term.open(instance.element)
    if (webgl) void loadWebgl(instance)
  }
  instance.visible = true
  fitNow(instance)
}

export function unmount(instance: Instance): void {
  instance.visible = false
  instance.element.remove()
}

async function loadWebgl(instance: Instance): Promise<void> {
  const m = await loadModules()
  try {
    const addon = new m.WebglAddon()
    // On a lost context, xterm.js falls back to its DOM renderer and keeps the buffer.
    addon.onContextLoss(() => addon.dispose())
    instance.term.loadAddon(addon)
  } catch (error) {
    console.warn('WebGL renderer unavailable; using the DOM renderer', error)
  }
}

export function fitNow(instance: Instance): void {
  if (!instance.visible || !instance.element.isConnected) return
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
    instance.element.remove()
    instance.term.dispose()
  })
}

export async function copySelection(instance: Instance): Promise<void> {
  const text = instance.term.getSelection()
  if (text) await navigator.clipboard.writeText(text)
}

export async function pasteClipboard(instance: Instance): Promise<void> {
  const text = await navigator.clipboard.readText()
  if (text) instance.term.paste(text)
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
