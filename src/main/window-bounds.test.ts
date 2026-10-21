import { describe, expect, it } from 'vitest'
import { parseWindowState, placeWindow, type Rect } from './window-bounds'

const primary: Rect = { x: 0, y: 25, width: 1440, height: 875 }
const secondary: Rect = { x: 1440, y: 0, width: 2560, height: 1440 }
const defaults = { width: 1280, height: 820 }
const min = { width: 960, height: 600 }

describe('placeWindow', () => {
  it('centers the default size on the primary display without a saved state', () => {
    expect(placeWindow(null, [primary], primary, defaults, min)).toEqual({
      bounds: { width: 1280, height: 820 },
      maximized: false,
    })
  })

  it('fits the default size into a small display', () => {
    const small = { x: 0, y: 0, width: 1024, height: 700 }
    expect(placeWindow(null, [small], small, defaults, min).bounds).toEqual({
      width: 1024,
      height: 700,
    })
  })

  it('keeps a saved position that is on a display', () => {
    const saved = { bounds: { x: 1600, y: 100, width: 1400, height: 900 }, maximized: true }
    expect(placeWindow(saved, [primary, secondary], primary, defaults, min)).toEqual({
      bounds: { x: 1600, y: 100, width: 1400, height: 900 },
      maximized: true,
    })
  })

  it('drops the position of a window whose display is gone', () => {
    const saved = { bounds: { x: 1600, y: 100, width: 2000, height: 1200 }, maximized: false }
    expect(placeWindow(saved, [primary], primary, defaults, min)).toEqual({
      bounds: { width: 1440, height: 875 },
      maximized: false,
    })
  })

  it('drops a position whose title bar is above the top of every display', () => {
    const saved = { bounds: { x: 100, y: -500, width: 1000, height: 700 }, maximized: false }
    expect(placeWindow(saved, [primary], primary, defaults, min).bounds).toEqual({
      width: 1000,
      height: 700,
    })
  })

  it('keeps a window that hangs partly off the side of a display', () => {
    const saved = { bounds: { x: 1300, y: 200, width: 1000, height: 700 }, maximized: false }
    expect(placeWindow(saved, [primary], primary, defaults, min).bounds).toEqual({
      x: 1300,
      y: 200,
      width: 1000,
      height: 700,
    })
  })

  it('never goes below the minimum size', () => {
    const saved = { bounds: { x: 10, y: 40, width: 300, height: 200 }, maximized: false }
    expect(placeWindow(saved, [primary], primary, defaults, min).bounds).toEqual({
      x: 10,
      y: 40,
      width: 960,
      height: 600,
    })
  })
})

describe('parseWindowState', () => {
  it('reads a valid state', () => {
    expect(
      parseWindowState({
        version: 1,
        bounds: { x: -10, y: 20, width: 1000, height: 700 },
        maximized: false,
      }),
    ).toEqual({ bounds: { x: -10, y: 20, width: 1000, height: 700 }, maximized: false })
  })

  it.each([
    [null],
    [{ version: 2, bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: false }],
    [{ version: 1, bounds: { x: 0, y: 0, width: 0, height: 1 }, maximized: false }],
    [{ version: 1, bounds: { x: 0.5, y: 0, width: 1, height: 1 }, maximized: false }],
    [{ version: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    [{ version: 1, maximized: true }],
  ])('rejects %j', (raw) => {
    expect(parseWindowState(raw)).toBeNull()
  })
})
