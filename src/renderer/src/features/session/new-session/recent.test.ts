import { describe, expect, it } from 'vitest'
import type { ArtifactSummary } from '@shared/artifacts'
import { RECENT, recentCards } from './recent'

const artifact = (id: string) => ({ id }) as ArtifactSummary
const places = Array.from({ length: RECENT }, () => null)

describe('recentCards', () => {
  it('holds the places before the first read, in sight', () => {
    expect(recentCards(null, false, false)).toEqual({ cards: places, shown: true })
  })

  it('shows the artifacts changed last, at most three', () => {
    const list = ['a', 'b', 'c', 'd'].map(artifact)
    expect(recentCards(list, false, false)).toEqual({ cards: list.slice(0, 3), shown: true })
    expect(recentCards(list.slice(0, 1), false, false).cards).toEqual([artifact('a')])
  })

  it('keeps its room out of sight with no artifacts or after a failed read', () => {
    expect(recentCards([], false, false)).toEqual({ cards: places, shown: false })
    expect(recentCards(null, true, false)).toEqual({ cards: places, shown: false })
  })

  it('keeps the artifacts read before a failed read', () => {
    const list = [artifact('a')]
    expect(recentCards(list, true, false)).toEqual({ cards: list, shown: true })
  })

  it('keeps its cards out of sight while the draft holds a message', () => {
    const list = [artifact('a')]
    expect(recentCards(list, false, true)).toEqual({ cards: list, shown: false })
    expect(recentCards(null, false, true)).toEqual({ cards: places, shown: false })
  })
})
