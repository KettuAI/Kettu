import { describe, expect, it } from 'vitest'
import { mentionText, selectedLines } from './mention-lines'

describe('selectedLines', () => {
  it('orders the ends of a selection on the new file', () => {
    expect(selectedLines({ start: 9, end: 4, side: 'additions', endSide: 'additions' })).toEqual([
      4, 9,
    ])
    expect(selectedLines({ start: 3, end: 3 })).toEqual([3, 3])
  })

  it('offers nothing for removed lines, numbered in the old file', () => {
    expect(selectedLines({ start: 2, end: 2, side: 'deletions' })).toBeNull()
    expect(selectedLines({ start: 2, end: 5, side: 'additions', endSide: 'deletions' })).toBeNull()
    expect(selectedLines(null)).toBeNull()
  })
})

describe('mentionText', () => {
  it("writes the file's name with its line or lines", () => {
    expect(mentionText('src/usage/usage-store.ts', [4, 5])).toBe('@usage-store.ts#L4-5')
    expect(mentionText('README.md', [7, 7])).toBe('@README.md#L7')
  })
})
