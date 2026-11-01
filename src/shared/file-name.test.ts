import { describe, expect, it } from 'vitest'
import { safeName } from './file-name'

const ID = 'fallback'

describe('safeName', () => {
  it('replaces what a file name cannot hold on any platform', () => {
    expect(safeName('Q3: plan/draft <v2>? "final" | a*b\\c', ID)).toBe(
      'Q3- plan-draft -v2-- -final- - a-b-c',
    )
    expect(safeName('tab\there\u0000\u007f', ID)).toBe('tab-here--')
  })

  it('trims dots and spaces at the ends, which Windows drops', () => {
    expect(safeName('  ..Report.. . ', ID)).toBe('Report')
    expect(safeName('a.b', ID)).toBe('a.b')
  })

  it('caps the name at 100 characters, without splitting one', () => {
    expect(safeName('a'.repeat(300), ID)).toBe('a'.repeat(100))
    expect(Array.from(safeName('😀'.repeat(300), ID))).toHaveLength(100)
    expect(safeName(`${'a'.repeat(99)}. b`, ID)).toBe('a'.repeat(99))
  })

  it('falls back to the id when nothing is left', () => {
    expect(safeName('', ID)).toBe(ID)
    expect(safeName(' . . ', ID)).toBe(ID)
  })
})
