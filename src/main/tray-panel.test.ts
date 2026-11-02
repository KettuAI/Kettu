import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ windows: [] as FakeWindowShape[] }))

interface FakeWindowShape {
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
  destroyed: boolean
  focused: number
  sent: string[]
  webContents: object
  emit(event: string): boolean
}

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class BrowserWindow extends Emitter {
    bounds: FakeWindowShape['bounds'] = null
    visible = false
    destroyed = false
    focused = 0
    sent: string[] = []
    webContents = Object.assign(new Emitter(), {
      send: (channel: string) => this.sent.push(channel),
      setWindowOpenHandler: () => {},
    })
    constructor() {
      super()
      electron.windows.push(this as never)
    }
    isDestroyed = () => this.destroyed
    isVisible = () => this.visible
    show = () => (this.visible = true)
    hide = () => (this.visible = false)
    focus = () => this.focused++
    setBounds = (bounds: FakeWindowShape['bounds']) => (this.bounds = bounds)
    setAlwaysOnTop = () => {}
    setVisibleOnAllWorkspaces = () => {}
    destroy = () => {
      this.destroyed = true
      this.visible = false
      this.emit('closed')
    }
  }
  return {
    BrowserWindow,
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
    },
  }
})
vi.mock('./renderer', () => ({
  loadRenderer: () => Promise.resolve(),
  rendererPage: (url: string) => (url.endsWith('/tray.html') ? 'tray' : 'index'),
}))
vi.mock('./window', () => ({ markPanel: () => {}, showMainWindow: () => {} }))
vi.mock('./events', () => ({ sendCommand: () => {} }))

const { panelBounds, panelHeight, PANEL_WIDTH, TrayPanel } = await import('./tray-panel')

const workArea = { x: 0, y: 25, width: 1440, height: 875 }
const icon = { x: 1200, y: 0, width: 32, height: 24 }

describe('panelBounds', () => {
  it('centres the panel under the icon, below the menu bar', () => {
    expect(panelBounds(icon, 400, workArea)).toEqual({
      x: 1216 - PANEL_WIDTH / 2,
      y: 30,
      width: PANEL_WIDTH,
      height: 400,
    })
  })

  it('keeps the panel inside the work area', () => {
    expect(panelBounds({ ...icon, x: 1420 }, 400, workArea).x).toBe(1440 - 8 - PANEL_WIDTH)
    expect(panelBounds({ ...icon, x: 4 }, 400, workArea).x).toBe(8)
    expect(panelBounds(icon, 2000, workArea).height).toBe(875 - 16)
  })

  it('opens over an icon low on its screen, as a taskbar holds it', () => {
    const low = { x: 1200, y: 860, width: 24, height: 40 }
    expect(panelBounds(low, 300, workArea).y).toBe(860 - 6 - 300)
  })
})

describe('panelHeight', () => {
  it('takes whole pixels within the bounds and refuses anything else', () => {
    expect(panelHeight(412.4)).toBe(412)
    expect(panelHeight(10)).toBe(120)
    expect(panelHeight(5000)).toBe(720)
    for (const value of [Number.NaN, Infinity, '400', null, undefined, {}]) {
      expect(panelHeight(value)).toBeNull()
    }
  })
})

describe('TrayPanel', () => {
  beforeEach(() => {
    electron.windows.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function make() {
    const deps = { systemLocale: 'en' as const, open: vi.fn(), quit: vi.fn() }
    return { panel: new TrayPanel(deps), deps }
  }

  it('shows once the page says how tall it is, and takes calls from that page alone', () => {
    const { panel } = make()
    panel.toggle(icon)
    const window = electron.windows[0]!
    expect(window.visible).toBe(false)
    expect(window.sent).toEqual([])
    expect(panel.owns(window.webContents as never)).toBe(true)
    expect(panel.owns(new EventEmitter() as never)).toBe(false)
    panel.resize(300)
    expect(window.visible).toBe(true)
    expect(window.focused).toBe(1)
    expect(window.bounds).toEqual(panelBounds(icon, 300, workArea))
  })

  it('closes on blur, and a click on the icon right after leaves it closed', () => {
    const { panel } = make()
    panel.toggle(icon)
    panel.resize(300)
    const window = electron.windows[0]!
    window.emit('blur')
    expect(window.visible).toBe(false)
    panel.toggle(icon)
    expect(window.visible).toBe(false)
    vi.advanceTimersByTime(400)
    panel.toggle(icon)
    panel.resize(300)
    expect(window.visible).toBe(true)
    panel.toggle(icon)
    expect(window.visible).toBe(false)
    expect(electron.windows).toHaveLength(1)
  })

  it("reopens only once the page answers 'tray:shown' with its height", () => {
    const { panel } = make()
    panel.toggle(icon)
    panel.resize(300)
    panel.toggle(icon)
    const window = electron.windows[0]!
    panel.toggle(icon)
    expect(window.sent).toEqual(['tray:shown'])
    expect(window.visible).toBe(false)
    panel.resize(450)
    expect(window.visible).toBe(true)
    expect(window.bounds).toEqual(panelBounds(icon, 450, workArea))
    // The answer stopped the wait, so the page is not taken for a failed one.
    vi.advanceTimersByTime(3000)
    panel.toggle(icon)
    panel.toggle(icon)
    expect(electron.windows).toHaveLength(1)
    expect(window.sent).toEqual(['tray:shown', 'tray:shown'])
  })

  it('reloads its own page and goes nowhere else', () => {
    const { panel } = make()
    panel.toggle(icon)
    const contents = electron.windows[0]!.webContents as EventEmitter
    const go = (url: string) => {
      const event = { preventDefault: vi.fn() }
      contents.emit('will-navigate', event, url)
      return event.preventDefault
    }
    expect(go('http://localhost:5173/tray.html')).not.toHaveBeenCalled()
    expect(go('http://localhost:5173/')).toHaveBeenCalled()
    expect(go('https://example.com/')).toHaveBeenCalled()
  })

  it('cancels an opening still waiting for the page on a second click', () => {
    const { panel } = make()
    panel.toggle(icon)
    panel.toggle(icon)
    const window = electron.windows[0]!
    panel.resize(300)
    expect(window.visible).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(window.visible).toBe(false)
    panel.toggle(icon)
    panel.resize(300)
    expect(window.visible).toBe(true)
  })

  it('opens all the same when the page never says how tall it is', () => {
    const { panel } = make()
    panel.toggle(icon)
    expect(electron.windows[0]!.visible).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(electron.windows[0]!.visible).toBe(true)
    expect(electron.windows[0]!.bounds).toEqual(panelBounds(icon, 120, workArea))
  })

  it('closes before it opens the window or quits', () => {
    const { panel, deps } = make()
    panel.toggle(icon)
    panel.resize(300)
    panel.open({ kind: 'session', sessionId: 's1' })
    expect(electron.windows[0]!.visible).toBe(false)
    expect(deps.open).toHaveBeenCalledWith({ kind: 'session', sessionId: 's1' })
    panel.quit()
    expect(deps.quit).toHaveBeenCalledOnce()
  })

  it('takes a new height while open without moving its top', () => {
    const { panel } = make()
    panel.toggle(icon)
    panel.resize(300)
    panel.resize(500)
    expect(electron.windows[0]!.bounds).toEqual(panelBounds(icon, 500, workArea))
    panel.resize('tall')
    expect(electron.windows[0]!.bounds!.height).toBe(500)
  })

  it('opens a fresh page after one that never said its height', () => {
    const { panel } = make()
    panel.toggle(icon)
    vi.advanceTimersByTime(3000)
    const failed = electron.windows[0]!
    expect(failed.visible).toBe(true)
    panel.toggle(icon)
    panel.toggle(icon)
    expect(failed.destroyed).toBe(true)
    expect(electron.windows).toHaveLength(2)
    const fresh = electron.windows[1]!
    expect(fresh.sent).toEqual([])
    // A late 'closed' from the old window leaves the fresh one's opening waiting.
    failed.emit('closed')
    expect(panel.owns(fresh.webContents as never)).toBe(true)
    panel.resize(300)
    expect(fresh.visible).toBe(true)
  })

  it('keeps the page that says its height after all', () => {
    const { panel } = make()
    panel.toggle(icon)
    vi.advanceTimersByTime(3000)
    const window = electron.windows[0]!
    panel.resize(300)
    expect(window.bounds).toEqual(panelBounds(icon, 300, workArea))
    panel.toggle(icon)
    panel.toggle(icon)
    expect(electron.windows).toHaveLength(1)
    expect(window.sent).toEqual(['tray:shown'])
  })
})
