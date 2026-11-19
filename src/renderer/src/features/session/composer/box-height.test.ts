import { describe, expect, it } from 'vitest'
import { draggedHeight, fixedHeight } from './box-height'

const bounds = { least: 44, most: 400 }

describe('fixedHeight', () => {
  it('keeps a height between the bounds', () => {
    expect(fixedHeight(120.4, bounds)).toBe(120)
  })

  it('caps a height at the most', () => {
    expect(fixedHeight(900, bounds)).toBe(400)
  })

  it('leaves the box automatic at its least height, so it still grows with the text', () => {
    expect(fixedHeight(44, bounds)).toBeNull()
    expect(fixedHeight(10, bounds)).toBeNull()
  })
})

describe('draggedHeight', () => {
  const start = { height: 44, ...bounds }

  it('changes nothing for a press that slips a pixel or two', () => {
    expect(draggedHeight(start, 0)).toBeUndefined()
    expect(draggedHeight(start, 1)).toBeUndefined()
    expect(draggedHeight(start, -2)).toBeUndefined()
  })

  it('follows the pointer once it has moved', () => {
    expect(draggedHeight(start, 60)).toBe(104)
    expect(draggedHeight({ ...start, height: 200 }, -60)).toBe(140)
  })

  it('returns to automatic when dragged down to the least height', () => {
    expect(draggedHeight({ ...start, height: 200 }, -300)).toBeNull()
  })
})
