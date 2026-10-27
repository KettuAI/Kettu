import { describe, expect, it } from 'vitest'
import { fitTable } from './table-fit'

const CAP = 8 * 15

describe('fitTable', () => {
  it('keeps whole words when the columns fit the room', () => {
    expect(fitTable(600, [100, 120, 380], CAP)).toEqual({ fit: 'whole', floors: [] })
  })

  it('gives floors capped at the cap when those fit', () => {
    expect(fitTable(300, [400, 300], CAP)).toEqual({ fit: 'floors', floors: [CAP, CAP] })
  })

  it('leaves a column narrower than the cap at its own width', () => {
    expect(fitTable(300, [40, 30, 600], CAP)).toEqual({ fit: 'floors', floors: [40, 30, CAP] })
  })

  it('stacks when even the floors do not fit side by side', () => {
    expect(fitTable(300, [CAP, CAP, CAP, 60], CAP)).toEqual({ fit: 'stack', floors: [] })
  })
})
