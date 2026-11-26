import { describe, expect, it } from 'vitest'
import { findSkillTokens, mentionedSkills, startsSlashWord } from './slash'

describe('startsSlashWord', () => {
  it('allows start of text, whitespace, and non-ASCII characters', () => {
    expect(startsSlashWord('/a', 0)).toBe(true)
    expect(startsSlashWord('hi /a', 3)).toBe(true)
    expect(startsSlashWord('line1\n/a', 6)).toBe(true)
    expect(startsSlashWord('使用/a', 2)).toBe(true)
  })

  it('rejects ASCII characters before a slash', () => {
    expect(startsSlashWord('src/a', 3)).toBe(false)
    expect(startsSlashWord('https://example.com/a', 19)).toBe(false)
    expect(startsSlashWord('v1/skill', 2)).toBe(false)
  })
})

describe('findSkillTokens and mentionedSkills', () => {
  const skills = ['code-review', 'security-audit', '$lint', 'skill:format']

  it('finds single and multiple skills at start, inline, and across lines', () => {
    const text = '/code-review check auth then /security-audit\nand /$lint'
    expect(findSkillTokens(text, skills)).toEqual([
      { from: 0, to: 12, name: 'code-review' },
      { from: 29, to: 44, name: 'security-audit' },
      { from: 49, to: 55, name: '$lint' },
    ])
    expect(mentionedSkills(text, skills)).toEqual(['code-review', 'security-audit', '$lint'])
  })

  it('handles CJK neighbors and trailing punctuation without eating paths or URLs', () => {
    const text =
      '请先用/code-review，再用/security-audit。不要匹配 src/code-review 或 https://a.com/security-audit'
    expect(findSkillTokens(text, skills)).toEqual([
      { from: 3, to: 15, name: 'code-review' },
      { from: 18, to: 33, name: 'security-audit' },
    ])
  })

  it('deduplicates repeated skills while preserving first-seen order', () => {
    const text = '/security-audit then /code-review and /security-audit again'
    expect(mentionedSkills(text, skills)).toEqual(['security-audit', 'code-review'])
  })

  it('requires exact case, known skill names, and clean word boundaries', () => {
    expect(
      findSkillTokens(
        '/Code-Review /unknown /code-review-v2 /code-review/subpath /skill:format! 请用/code-review排查',
        skills,
      ),
    ).toEqual([
      { from: 59, to: 72, name: 'skill:format' },
      { from: 76, to: 88, name: 'code-review' },
    ])
  })
})
