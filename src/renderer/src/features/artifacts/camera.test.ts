import { describe, expect, it } from 'vitest'
import {
  atMaxZoom,
  atMinZoom,
  between,
  fitBox,
  labelRoom,
  livePages,
  MAX_ZOOM,
  MIN_ZOOM,
  pageAt,
  pageInNextRow,
  reveal,
  stepZoom,
  zoomAt,
} from './camera'
import type { PlacedPage } from './canvas'

const VIEW = { width: 1000, height: 700 }

function placed(x: number, y: number, width = 100, height = 100): PlacedPage {
  return { name: null, number: 1, group: 0, index: 1, width, height, x, y }
}

describe('fitBox', () => {
  it('shows a large canvas whole and centred', () => {
    const camera = fitBox({ x: 0, y: 0, width: 4000, height: 1000 }, VIEW)
    expect(camera.z).toBeCloseTo((1000 - 96) / 4000)
    expect(camera.x).toBeCloseTo((1000 - 4000 * camera.z) / 2)
  })

  it('never fits above 100%', () => {
    expect(fitBox({ x: 0, y: 0, width: 200, height: 100 }, VIEW).z).toBe(1)
  })

  it('fits a box away from the origin, below a bar', () => {
    const box = { x: 500, y: 300, width: 390, height: 844 }
    const camera = fitBox(box, VIEW, 52)
    const top = box.y * camera.z + camera.y
    expect(top).toBeGreaterThan(52)
    expect(box.x * camera.z + camera.x + (box.width * camera.z) / 2).toBeCloseTo(500)
  })
})

describe('zooming', () => {
  it('keeps the point under the pointer still', () => {
    const camera = { x: 10, y: 20, z: 0.5 }
    const next = zoomAt(camera, 2, 300, 200)
    expect((300 - camera.x) / camera.z).toBeCloseTo((300 - next.x) / next.z)
    expect((200 - camera.y) / camera.z).toBeCloseTo((200 - next.y) / next.z)
  })

  it('stops at 5% and 400%', () => {
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 100, 0, 0).z).toBe(MAX_ZOOM)
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 0.001, 0, 0).z).toBe(MIN_ZOOM)
  })

  it('steps through 5, 10, 25, 50, 100, 200 and 400%', () => {
    expect(stepZoom(0.37, 1)).toBe(0.5)
    expect(stepZoom(0.37, -1)).toBe(0.25)
    expect(stepZoom(1, 1)).toBe(2)
    expect(stepZoom(4, 1)).toBe(4)
    expect(stepZoom(0.05, -1)).toBe(0.05)
  })

  it('knows the limits a glide ends on, a hair off them', () => {
    const out = between({ x: 0, y: 0, z: 0.5 }, { x: 0, y: 0, z: MIN_ZOOM }, 1, VIEW).z
    const into = between({ x: 0, y: 0, z: 0.5 }, { x: 0, y: 0, z: MAX_ZOOM }, 1, VIEW).z
    expect(atMinZoom(out)).toBe(true)
    expect(atMaxZoom(into)).toBe(true)
    expect(atMinZoom(0.1)).toBe(false)
    expect(atMaxZoom(2)).toBe(false)
  })

  it('moves between cameras with the zoom on a log scale', () => {
    const a = { x: 0, y: 0, z: 0.25 }
    const b = { x: -500, y: -200, z: 1 }
    expect(between(a, b, 0, VIEW)).toEqual(a)
    const end = between(a, b, 1, VIEW)
    expect(end.z).toBeCloseTo(1)
    expect(end.x).toBeCloseTo(b.x)
    expect(end.y).toBeCloseTo(b.y)
    expect(between(a, b, 0.5, VIEW).z).toBeCloseTo(0.5)
  })
})

describe('reveal', () => {
  it('moves only as far as the page needs', () => {
    const camera = { x: 0, y: 0, z: 1 }
    expect(reveal(camera, { x: 100, y: 100, width: 100, height: 100 }, VIEW)).toEqual(camera)
    const moved = reveal(camera, { x: 1200, y: 100, width: 100, height: 100 }, VIEW)
    expect(moved).toEqual({ x: 1000 - 48 - 1300, y: 0, z: 1 })
  })
})

describe('pages', () => {
  const pages = [placed(0, 0), placed(148, 0), placed(296, 0), placed(0, 320), placed(300, 320)]

  it('finds the page under a point', () => {
    expect(pageAt(pages, { x: 0, y: 0, z: 1 }, 160, 50)).toBe(1)
    expect(pageAt(pages, { x: 0, y: 0, z: 1 }, 120, 50)).toBe(-1)
  })

  it('takes the nearest page in the row above or below', () => {
    expect(pageInNextRow(pages, 2, 1)).toBe(4)
    expect(pageInNextRow(pages, 3, -1)).toBe(0)
    expect(pageInNextRow(pages, 0, -1)).toBe(-1)
  })

  it('keeps live the pages near the view, nearest first, up to the cap', () => {
    const far = [placed(0, 0), placed(100_000, 0), placed(500, 0)]
    expect(livePages(far, { x: 0, y: 0, z: 1 }, VIEW)).toEqual([2, 0])
    expect(livePages(far, { x: 0, y: 0, z: 1 }, VIEW, 1)).toEqual([2])
  })
})

describe('labelRoom', () => {
  it('hides page names under 44 px between rows, and titles under 22 px', () => {
    expect(labelRoom(0.25)).toEqual({ names: true, title: true })
    expect(labelRoom(0.15)).toEqual({ names: false, title: true })
    expect(labelRoom(0.05)).toEqual({ names: false, title: false })
  })
})
