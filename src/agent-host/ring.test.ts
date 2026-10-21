import { describe, expect, it } from 'vitest'
import { Ring, TextRing } from './ring'

describe('Ring', () => {
  it('keeps the newest items by count', () => {
    const ring = new Ring<number>(3)
    for (let i = 0; i < 2000; i++) ring.push(i)
    expect(ring.toArray()).toEqual([1997, 1998, 1999])
    expect(ring.length).toBe(3)
  })

  it('also keeps the total size under its budget', () => {
    const ring = new Ring<string>(100, 10)
    ring.push('a', 4)
    ring.push('b', 4)
    ring.push('c', 4)
    expect(ring.toArray()).toEqual(['b', 'c'])
    expect(ring.size).toBe(8)
    ring.push('huge', 50)
    expect(ring.toArray()).toEqual([])
    expect(ring.size).toBe(0)
  })
})

describe('TextRing', () => {
  it('keeps the last characters', () => {
    const ring = new TextRing(8)
    ring.push('hello ')
    ring.push('world!')
    expect(ring.toString()).toBe('o world!')
    ring.push('0123456789')
    expect(ring.toString()).toBe('23456789')
  })

  it('returns the last lines, folding carriage-return progress bars', () => {
    const ring = new TextRing(1024)
    ring.push('first\r\nnpm WARN deprecated\n')
    ring.push('downloading 10%\rdownloading 55%\r\n\n')
    expect(ring.lastLines(2)).toEqual(['npm WARN deprecated', 'downloading 55%'])
  })
})
