import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { badgeLabel, encodePng, renderBadge } from './badge-image'

function pixel(rgba: Buffer, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4
  return [...rgba.subarray(offset, offset + 4)]
}

describe('badgeLabel', () => {
  it.each([
    [0, null],
    [-1, null],
    [Number.NaN, null],
    [1, '1'],
    [9, '9'],
    [10, '9+'],
    [250, '9+'],
  ])('labels %d as %j', (count, label) => {
    expect(badgeLabel(count)).toBe(label)
  })
})

describe('renderBadge', () => {
  it('draws a disc with a transparent outside', () => {
    const size = 32
    const rgba = renderBadge('1', size)
    expect(rgba.length).toBe(size * size * 4)
    expect(pixel(rgba, size, 0, 0)[3]).toBe(0)
    expect(pixel(rgba, size, 31, 31)[3]).toBe(0)
    expect(pixel(rgba, size, 6, 16)).toEqual([0xff, 0x3b, 0x30, 255])
  })

  it('draws the count in white', () => {
    const size = 32
    // The stem of the "1" runs down the middle of the disc.
    const stem = pixel(renderBadge('1', size), size, 16, 18)
    expect(stem.slice(0, 3).every((channel) => channel > 200)).toBe(true)
    expect(stem[3]).toBe(255)
  })

  it.each(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '9+'])(
    'gives "%s" visible ink',
    (label) => {
      const rgba = renderBadge(label, 16)
      let ink = 0
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 1] > 200 && rgba[i + 3] > 0) ink++
      expect(ink).toBeGreaterThan(8)
    },
  )
})

describe('encodePng', () => {
  it('writes a PNG whose image data round-trips', async () => {
    const size = 16
    const rgba = renderBadge('9+', size)
    const png = await encodePng(rgba, size, size)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(size)
    expect(png.readUInt32BE(20)).toBe(size)
    const idatLength = png.readUInt32BE(33)
    expect(png.toString('ascii', 37, 41)).toBe('IDAT')
    const rows = inflateSync(png.subarray(41, 41 + idatLength))
    expect(rows.length).toBe((size * 4 + 1) * size)
    expect(rows.subarray(1 + 5 * 4, 1 + 6 * 4)).toEqual(rgba.subarray(5 * 4, 6 * 4))
  })
})
