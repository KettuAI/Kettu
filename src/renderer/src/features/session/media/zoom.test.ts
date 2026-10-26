import { describe, expect, it } from 'vitest'
import { bounded, fitZoom, isZoomed, MAX_ZOOM, snapped, stepZoom, toggled, zoomAt } from './zoom'

const STAGE = { width: 1096, height: 696 }
const PICTURE = { width: 4000, height: 3000 }
const FIT = fitZoom(PICTURE, STAGE)

describe('fitZoom', () => {
  it('fits a large picture inside the stage less 48 px on each side', () => {
    expect(FIT).toBeCloseTo(600 / 3000)
    expect(fitZoom({ width: 3000, height: 500 }, STAGE)).toBeCloseTo(1000 / 3000)
  })

  it('never enlarges a picture past its own pixels', () => {
    expect(fitZoom({ width: 200, height: 100 }, STAGE)).toBe(1)
  })
})

describe('bounded', () => {
  it('zooms from the fit to 800%', () => {
    expect(bounded({ x: 0, y: 0, z: 0.01 }, PICTURE, STAGE, FIT).z).toBe(FIT)
    expect(bounded({ x: 0, y: 0, z: 20 }, PICTURE, STAGE, FIT).z).toBe(MAX_ZOOM)
  })

  it('pans a zoomed picture until it is 24 px past the stage edge', () => {
    const camera = bounded({ x: 1e6, y: -1e6, z: 1 }, PICTURE, STAGE, FIT)
    expect(camera.x).toBe((4000 - 1096) / 2 + 24)
    expect(camera.y).toBe(-((3000 - 696) / 2 + 24))
  })

  it('keeps the picture centred along an axis it fits along', () => {
    const wide = { width: 4000, height: 400 }
    const camera = bounded({ x: 50, y: 50, z: 1 }, wide, STAGE, fitZoom(wide, STAGE))
    expect(camera).toEqual({ x: 50, y: 0, z: 1 })
  })
})

describe('zoomAt', () => {
  it('keeps the point under the pointer still', () => {
    const camera = { x: 0, y: 0, z: 1 }
    const next = zoomAt(camera, 2, 300, -100, PICTURE, STAGE, FIT)
    expect((300 - camera.x) / camera.z).toBeCloseTo((300 - next.x) / next.z)
    expect((-100 - camera.y) / camera.z).toBeCloseTo((-100 - next.y) / next.z)
  })

  it('stops at its bounds', () => {
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 100, 0, 0, PICTURE, STAGE, FIT).z).toBe(MAX_ZOOM)
    expect(zoomAt({ x: 400, y: 0, z: 1 }, 0.01, 400, 0, PICTURE, STAGE, FIT)).toEqual({
      x: 0,
      y: 0,
      z: FIT,
    })
  })
})

describe('stepZoom', () => {
  it('steps by 1.25 between the fit and 800%', () => {
    expect(stepZoom(1, 1, FIT)).toBe(1.25)
    expect(stepZoom(1, -1, FIT)).toBe(0.8)
    expect(stepZoom(7, 1, FIT)).toBe(MAX_ZOOM)
    expect(stepZoom(FIT * 1.1, -1, FIT)).toBe(FIT)
  })
})

describe('snapped', () => {
  it('snaps a zoom within 5% of the fit back to the fit, centred', () => {
    expect(snapped({ x: 10, y: 4, z: FIT * 1.04 }, FIT)).toEqual({ x: 0, y: 0, z: FIT })
    expect(snapped({ x: 10, y: 4, z: FIT * 1.06 }, FIT)).toEqual({ x: 10, y: 4, z: FIT * 1.06 })
  })
})

describe('toggled', () => {
  it('goes from the fit to 100% at the point, and back from any zoom', () => {
    const fitted = { x: 0, y: 0, z: FIT }
    const actual = toggled(fitted, 200, 100, PICTURE, STAGE, FIT)
    expect(actual.z).toBe(1)
    expect(isZoomed(actual, FIT)).toBe(true)
    expect((200 - actual.x) / actual.z).toBeCloseTo(200 / FIT)
    expect(toggled({ x: 30, y: 0, z: 3 }, 0, 0, PICTURE, STAGE, FIT)).toEqual(fitted)
  })

  it('leaves a picture no larger than the stage at 100%', () => {
    const small = { width: 200, height: 100 }
    expect(toggled({ x: 0, y: 0, z: 1 }, 50, 50, small, STAGE, 1)).toEqual({ x: 0, y: 0, z: 1 })
  })
})
