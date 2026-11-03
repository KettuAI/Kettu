import { describe, expect, it } from 'vitest'
import { titleBarHeight, trafficLightPosition } from './window-controls'

// The traffic lights' centre, in window pixels: the 48 px top bar's, 8 px below the window's top.
const centre = (zoom: number) => trafficLightPosition(zoom).y + 6
const BAR_CENTRE = 8 + 48 / 2

describe('trafficLightPosition', () => {
  it('centres the traffic lights on the top bar at 100%', () => {
    expect(trafficLightPosition(1)).toEqual({ x: 20, y: 26 })
    expect(centre(1)).toBe(BAR_CENTRE)
  })

  it('moves them with the zoomed top bar', () => {
    // Whole pixels, so up to half a pixel off the bar's centre.
    expect(trafficLightPosition(1.25)).toEqual({ x: 25, y: 34 })
    expect(Math.abs(centre(1.25) - BAR_CENTRE * 1.25)).toBeLessThanOrEqual(0.5)
    expect(trafficLightPosition(0.9)).toEqual({ x: 18, y: 23 })
    expect(Math.abs(centre(0.9) - BAR_CENTRE * 0.9)).toBeLessThanOrEqual(0.5)
  })
})

describe('titleBarHeight', () => {
  it('gives the overlay the 40 px band, zoomed', () => {
    expect(titleBarHeight(1)).toBe(40)
    expect(titleBarHeight(1.25)).toBe(50)
    expect(titleBarHeight(0.9)).toBe(36)
  })
})
