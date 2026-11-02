import { describe, expect, it } from 'vitest'
import { shownPlace } from './queue-place'

describe('shownPlace', () => {
  it('keeps showing a message while the ones before it are sent', () => {
    expect(shownPlace(['b', 'c'], { id: 'c', index: 2 })).toBe(1)
  })

  it('shows the message now in its place once it leaves', () => {
    expect(shownPlace(['a', 'c'], { id: 'b', index: 1 })).toBe(1)
    expect(shownPlace(['a'], { id: 'c', index: 2 })).toBe(0)
  })

  it('starts at the next message', () => {
    expect(shownPlace(['a', 'b'], { id: null, index: 0 })).toBe(0)
  })
})
