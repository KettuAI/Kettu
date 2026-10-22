import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, stepZoom } from './settings'

describe('stepZoom', () => {
  it("steps through Chrome's zoom levels", () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1.1, -1)).toBe(1)
    expect(stepZoom(0.9, -1)).toBe(0.8)
  })

  it('holds at the ends', () => {
    expect(stepZoom(1.5, 1)).toBe(1.5)
    expect(stepZoom(0.8, -1)).toBe(0.8)
  })

  it('resets to the default', () => {
    expect(stepZoom(1.5, 0)).toBe(DEFAULT_SETTINGS.appearance.zoom)
    expect(DEFAULT_SETTINGS.appearance.zoom).toBe(1.1)
  })
})
