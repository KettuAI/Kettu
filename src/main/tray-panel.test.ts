import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ windows: [] as FakeWindowShape[] }))

interface FakeWindowShape {
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
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
    isDestroyed = () => false
    isVisible = () => this.visible
    show = () => (this.visible = true)
    hide = () => (this.visible = false)
    focus = () => this.focused++
    setBounds = (bounds: FakeWindowShape['bounds']) => (this.bounds = bounds)
    setAlwaysOnTop = () => {}
    setVisibleOnAllWorkspaces = () => {}
    destroy = () => {}
  }
  return {
    BrowserWindow,
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }),
    },
  }
})
vi.mock('./renderer', () => ({ loadRenderer: () => Promise.resolve() }))
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
    expect(window.visible).toBe(true)
    expect(window.sent).toEqual(['tray:shown'])
    panel.toggle(icon)
    expect(window.visible).toBe(false)
    expect(electron.windows).toHaveLength(1)
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
})
