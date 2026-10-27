import { describe, expect, it } from 'vitest'
import { imageSurface } from './surface'

describe('imageSurface', () => {
  it('gives an SVG the canvas, by its path in any letter case or by its type', () => {
    for (const path of ['logo.svg', '/tmp/Logo.SVG', 'C:\\art\\mark.Svg', 'a.svg']) {
      expect(imageSurface({ path })).toBe('canvas')
    }
    expect(imageSurface({ mimeType: 'image/svg+xml' })).toBe('canvas')
    expect(imageSurface({ path: 'logo.svg', mimeType: 'image/png' })).toBe('canvas')
  })

  it('gives every other image the checkerboard', () => {
    for (const path of ['shot.png', 'photo.JPEG', 'no-extension']) {
      expect(imageSurface({ path })).toBe('checker')
    }
    expect(imageSurface({ path: 'shot.png', mimeType: 'image/png' })).toBe('checker')
    expect(imageSurface({ mimeType: 'image/jpeg' })).toBe('checker')
  })
})
