import { describe, expect, it } from 'vitest'
import { titleBarHeight, trafficLightPosition } from './window-controls'

// The traffic lights' centre, in window pixels: the 48 px top bar's, below the desk's 8 px gap.
const centre = (zoom: number) => trafficLightPosition(zoom).y + 6

describe('trafficLightPosition', () => {
  it('centres the traffic lights on the top bar inside its sheet at 100%', () => {
    expect(trafficLightPosition(1)).toEqual({ x: 16, y: 26 })
    expect(centre(1)).toBe(8 + 48 / 2)
  })

  it('moves them with the zoomed top bar and the gap above it', () => {
    expect(trafficLightPosition(1.25)).toEqual({ x: 20, y: 34 })
    expect(centre(1.25)).toBe((8 + 48 / 2) * 1.25)
    expect(trafficLightPosition(0.9)).toEqual({ x: 14, y: 23 })
    expect(centre(0.9)).toBeCloseTo((8 + 48 / 2) * 0.9, 0)
  })
})

describe('titleBarHeight', () => {
  it('gives the overlay the 40 px band, zoomed', () => {
    expect(titleBarHeight(1)).toBe(40)
    expect(titleBarHeight(1.25)).toBe(50)
    expect(titleBarHeight(0.9)).toBe(36)
  })
})
