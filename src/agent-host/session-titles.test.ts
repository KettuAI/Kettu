import { describe, expect, it } from 'vitest'
import { listedTitle } from './session-titles'

describe('a title an agent lists', () => {
  const index = '<kettu-memory>\nKettu keeps this memory.\n</kettu-memory>'

  it('leaves out what Kettu sent ahead of the first prompt', () => {
    expect(listedTitle(`${index}\n\nFix the build`, 'Fix the build')).toBeNull()
    expect(listedTitle(`${index}\n\nFix login`, 'Fix the build')).toBe('Fix login')
    expect(listedTitle('<kettu-memory> Kettu keeps this memory…', 'Fix the build')).toBeNull()
  })

  it('keeps a plain title and drops an empty one', () => {
    expect(listedTitle(' Fix login ', 'Fix the build')).toBe('Fix login')
    expect(listedTitle('  ', null)).toBeNull()
  })
})
